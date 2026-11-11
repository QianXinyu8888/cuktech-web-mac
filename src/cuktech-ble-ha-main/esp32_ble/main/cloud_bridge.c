#include "cloud_bridge.h"
#include "cloud_history.h"
#include "esp_random.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_websocket_client.h"
#include "esp_crt_bundle.h"
#include "esp_sntp.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/queue.h"
#include "cJSON.h"
#include <sys/time.h>

static const char *TAG="CLOUD";
static char uri[256], authorization[288];
static TaskHandle_t cloud_task_handle;
static cloud_snapshot_cb get_snapshot;
static cloud_command_cb dispatch_command;
static cloud_settings_cb get_settings, get_automation;
static QueueHandle_t incoming_commands, completed_commands, history_acks;
static SemaphoreHandle_t history_mutex;
static CloudHistoryQueue history_queue;
typedef struct { char id[37]; bool ok; char error[64]; } CloudCompletion;
static CloudCommandGate command_gate;
static uint64_t utc_ms(void) { struct timeval tv; gettimeofday(&tv,NULL); return (uint64_t)tv.tv_sec*1000+tv.tv_usec/1000; }
void cloud_bridge_complete(const char *id, bool ok, const char *error) {
    if (!completed_commands || !id || !id[0]) return;
    CloudCompletion result={.ok=ok};
    snprintf(result.id,sizeof result.id,"%s",id);
    if (error) snprintf(result.error,sizeof result.error,"%s",error);
    xQueueSend(completed_commands,&result,0);
    if (cloud_task_handle) xTaskNotifyGive(cloud_task_handle);
}

static EventGroupHandle_t signals;

#define CLOUD_CONNECTED BIT0
#define CLOUD_FAST BIT1
#define CLOUD_NEW_CONNECTION BIT2
static CloudRx rx;

static bool wifi_online(void) {
    esp_netif_t *sta=esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip;
    return sta && esp_netif_is_netif_up(sta) && esp_netif_get_ip_info(sta,&ip)==ESP_OK && ip.ip.addr;
}
static void socket_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)base;
    esp_websocket_event_data_t *e=data;
    if (id==WEBSOCKET_EVENT_CONNECTED) {
        memset(&rx,0,sizeof rx);
        xEventGroupClearBits(signals,CLOUD_FAST);
        xEventGroupSetBits(signals,CLOUD_CONNECTED|CLOUD_NEW_CONNECTION);
        xTaskNotifyGive(cloud_task_handle);
        ESP_LOGI(TAG,"Secure cloud connection established");
    } else if (id==WEBSOCKET_EVENT_DISCONNECTED || id==WEBSOCKET_EVENT_ERROR) {
        xEventGroupClearBits(signals,CLOUD_CONNECTED|CLOUD_FAST);
        memset(&rx,0,sizeof rx);
        ESP_LOGW(TAG,"Cloud connection unavailable; retrying");
    } else if (id==WEBSOCKET_EVENT_DATA && e->data_len>=0 && e->payload_offset>=0 && e->payload_len>=0) {
        if (cloud_rx_frame(&rx,e->op_code,e->fin,e->data_ptr,e->data_len,e->payload_offset,e->payload_len)) {
            int rate=cloud_parse_rate(rx.data,rx.length);
            if (rate==1000) xEventGroupSetBits(signals,CLOUD_FAST);
            else if (rate==30000) xEventGroupClearBits(signals,CLOUD_FAST);
            if (!rate) {
                char ack[37];
                CloudCommand command;
                if (cloud_parse_history_ack(rx.data,rx.length,ack)) xQueueSend(history_acks,ack,0);
                else if (cloud_parse_command(rx.data,rx.length,utc_ms(),&command))
                    xQueueSend(incoming_commands,&command,0);
            }
            xTaskNotifyGive(cloud_task_handle);
        }
    }
}
static void send_result(esp_websocket_client_handle_t client, const CloudCompletion *result) {
    cJSON *root=cJSON_CreateObject();
    if (!root) return;
    cJSON_AddStringToObject(root,"type","command_result");
    cJSON_AddStringToObject(root,"id",result->id); cJSON_AddBoolToObject(root,"ok",result->ok);
    if (!result->ok) cJSON_AddStringToObject(root,"error",result->error[0]?result->error:"ble_failed");
    char message[256];
    int expected=result->ok?3:4;
    if (cJSON_GetArraySize(root)==expected && cJSON_PrintPreallocated(root,message,sizeof message,false))
        esp_websocket_client_send_text(client,message,strlen(message),pdMS_TO_TICKS(1000));
    cJSON_Delete(root);
}
/* Sampling has its own task so TLS/reconnect/send waits cannot pause the one-second clock. */
static void history_sampler(void *arg) {
    (void)arg;
    TickType_t wake=xTaskGetTickCount(); uint32_t previous=0;
    for (;;) {
        vTaskDelayUntil(&wake,pdMS_TO_TICKS(1000));
        uint32_t timestamp=utc_ms()/1000;
        if (timestamp<1704067200 || timestamp<=previous) continue;
        previous=timestamp;
        CloudSnapshot snapshot={0}; CloudHistorySample sample;
        if (!get_snapshot(&snapshot) || !cloud_history_pack(&snapshot,timestamp,&sample)) {
            ESP_LOGW(TAG,"History sample unavailable at %lu",(unsigned long)timestamp); continue;
        }
        xSemaphoreTake(history_mutex,portMAX_DELAY);
        bool queued=cloud_history_push(&history_queue,&sample);
        uint32_t dropped=history_queue.dropped; size_t count=history_queue.count;
        xSemaphoreGive(history_mutex);
        if (!queued && (dropped==1 || dropped%60==0))
            ESP_LOGW(TAG,"History FIFO full: dropped NEW sample at %lu; total dropped=%lu, retained oldest %u seconds until ACK",
                (unsigned long)timestamp,(unsigned long)dropped,CLOUD_HISTORY_CAPACITY);
        if (count>=CLOUD_HISTORY_BATCH_MAX && cloud_task_handle) xTaskNotifyGive(cloud_task_handle);
    }
}
static void batch_uuid(char out[37]) {
    uint8_t bytes[16]; esp_fill_random(bytes,sizeof bytes);
    bytes[6]=(bytes[6]&15)|0x40; bytes[8]=(bytes[8]&63)|0x80;
    snprintf(out,37,"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],
        bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]);
}
/* Send each small batch in one call so the websocket task can receive replies
   between batches instead of blocking realtime telemetry on dozens of writes. */
static bool send_history_batch(esp_websocket_client_handle_t client, const char *id, size_t count) {
    size_t capacity=CLOUD_HISTORY_BATCH_MAX*1024+128;
    char *message=malloc(capacity);if(!message)return false;
    xSemaphoreTake(history_mutex,portMAX_DELAY);
    bool formatted=cloud_history_format_batch(&history_queue,id,count,message,capacity);
    xSemaphoreGive(history_mutex);
    int length=formatted?(int)strlen(message):0;
    bool sent=formatted&&esp_websocket_client_send_text(client,message,length,pdMS_TO_TICKS(5000))==length;
    free(message);return sent;
}
static void cloud_task(void *arg) {
    (void)arg;
    /* RTC must be plausible before certificate validation. Never bypass TLS. */
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0,"pool.ntp.org");
    esp_sntp_init();
    esp_websocket_client_config_t conf={
        .uri=uri, .headers=authorization, .crt_bundle_attach=esp_crt_bundle_attach,
        .reconnect_timeout_ms=2000, .network_timeout_ms=10000,
        .ping_interval_sec=20, .pingpong_timeout_sec=30,
        .buffer_size=4096, .task_stack=6144,
    };
    esp_websocket_client_handle_t client=NULL;
    uint64_t seq=0;
    int64_t last_sent=-30000;
    char message[1536], last_settings[1024]={0}, last_automation[1024]={0};
    CloudCommand pending={0};
    int64_t last_settings_check=-1000, last_history_attempt=-30000;
    const char *last_ble_phase=NULL;
    CloudHistoryFlight history_flight={0};
    for (;;) {
        time_t now=time(NULL);
        if (!wifi_online() || now<1704067200) {
            if (client) {
                esp_websocket_client_stop(client);
                esp_websocket_client_destroy(client); client=NULL;
                xEventGroupClearBits(signals,CLOUD_CONNECTED|CLOUD_FAST);
            }
            ulTaskNotifyTake(pdTRUE,pdMS_TO_TICKS(1000)); continue;
        }
        if (!client) {
            client=esp_websocket_client_init(&conf);
            if (!client) { vTaskDelay(pdMS_TO_TICKS(10000)); continue; }
            esp_websocket_register_events(client,WEBSOCKET_EVENT_ANY,socket_event,NULL);
            if (esp_websocket_client_start(client)!=ESP_OK) {
                esp_websocket_client_destroy(client); client=NULL;
                vTaskDelay(pdMS_TO_TICKS(10000)); continue;
            }
        }
        EventBits_t flags=xEventGroupGetBits(signals);
        int interval=(flags&CLOUD_FAST)?1000:30000;
        int64_t uptime=esp_timer_get_time()/1000;
        /* The cloud task owns pending state and the dedup window; network callbacks only enqueue. */
        CloudCompletion result;
        while (xQueueReceive(completed_commands,&result,0)==pdTRUE) {
            if (pending.id[0] && !strcmp(result.id,pending.id)) {
                if (utc_ms()>=pending.expires_at) { result.ok=false; snprintf(result.error,sizeof result.error,"expired"); }
                if (flags&CLOUD_CONNECTED) send_result(client,&result);
                pending.id[0]=0;
            }
        }
        if (pending.id[0] && utc_ms()>=pending.expires_at) {
            result=(CloudCompletion){.ok=false}; strcpy(result.id,pending.id); strcpy(result.error,"timeout");
            if (flags&CLOUD_CONNECTED) send_result(client,&result);
            pending.id[0]=0;
        }
        CloudCommand command;
        while (xQueueReceive(incoming_commands,&command,0)==pdTRUE) {
            uint64_t wall=utc_ms();
            if (command.expires_at<=wall) continue;
            int record=cloud_command_record(&command_gate,&command,wall);
            if (record==0) continue; /* duplicate pending/completed ID is never dispatched again */
            result=(CloudCompletion){.ok=false}; strcpy(result.id,command.id);
            if (record<0 || pending.id[0]) {
                strcpy(result.error,"busy"); if (flags&CLOUD_CONNECTED) send_result(client,&result); continue;
            }
            if (!(flags&CLOUD_CONNECTED)) continue; /* don't execute a command after its socket disappeared */
            if (!dispatch_command || !dispatch_command(&command)) {
                strcpy(result.error,"queue_unavailable"); send_result(client,&result); continue;
            }
            pending=command;
        }
        char acknowledged[37];
        while (xQueueReceive(history_acks,acknowledged,0)==pdTRUE) {
            if (history_flight.count && !strcmp(acknowledged,history_flight.id)) {
                xSemaphoreTake(history_mutex,portMAX_DELAY);
                cloud_history_ack_batch(&history_queue,&history_flight,acknowledged);
                xSemaphoreGive(history_mutex);
            }
        }
        if (!history_flight.count) {
            xSemaphoreTake(history_mutex,portMAX_DELAY);
            size_t available=history_queue.count;
            xSemaphoreGive(history_mutex);
            if (available>=CLOUD_HISTORY_BATCH_MAX) {
                char id[37]; batch_uuid(id);
                xSemaphoreTake(history_mutex,portMAX_DELAY);
                cloud_history_begin_batch(&history_queue,&history_flight,id);
                xSemaphoreGive(history_mutex);
                last_history_attempt=-30000;
            }
        }
        if ((flags&CLOUD_CONNECTED) && history_flight.count &&
            ((flags&CLOUD_NEW_CONNECTION) || uptime-last_history_attempt>=30000)) {
            last_history_attempt=uptime;
            if (!send_history_batch(client,history_flight.id,history_flight.count)) {
                ESP_LOGW(TAG,"History send incomplete; retaining batch for retry after reconnect");
                esp_websocket_client_stop(client); esp_websocket_client_destroy(client); client=NULL;
                xEventGroupClearBits(signals,CLOUD_CONNECTED|CLOUD_FAST); continue;
            }
            /* Deliberately retain all rows and the same UUID until matching transaction ACK. */
        }
        if ((flags&CLOUD_CONNECTED) && get_automation &&
            ((flags&CLOUD_NEW_CONNECTION) || uptime-last_settings_check>=1000)) {
            char automation[1024];
            if (get_automation(automation,sizeof automation) && ((flags&CLOUD_NEW_CONNECTION) || strcmp(automation,last_automation))) {
                int length=strlen(automation);
                if (esp_websocket_client_send_text(client,automation,length,pdMS_TO_TICKS(1000))==length)
                    strcpy(last_automation,automation);
            }
        }
        if ((flags&CLOUD_CONNECTED) && get_settings &&
            ((flags&CLOUD_NEW_CONNECTION) || uptime-last_settings_check>=1000)) {
            last_settings_check=uptime;
            char settings[1024];
            if (get_settings(settings,sizeof settings) && ((flags&CLOUD_NEW_CONNECTION) || strcmp(settings,last_settings))) {
                int length=strlen(settings);
                if (esp_websocket_client_send_text(client,settings,length,pdMS_TO_TICKS(1000))==length) {
                    strcpy(last_settings,settings); xEventGroupClearBits(signals,CLOUD_NEW_CONNECTION);
                }
            }
        }
        if (flags&CLOUD_CONNECTED) {
            CloudSnapshot snapshot={0};
            if (get_snapshot(&snapshot) && ((flags&CLOUD_NEW_CONNECTION) || uptime-last_sent>=interval || (snapshot.ble_phase && (!last_ble_phase || strcmp(last_ble_phase,snapshot.ble_phase)))) && cloud_format_telemetry(&snapshot,seq,message,sizeof message)) {
                int length=strlen(message);
                if (esp_websocket_client_send_text(client,message,length,pdMS_TO_TICKS(3000))==length) {
                    last_sent=uptime; last_ble_phase=snapshot.ble_phase; seq=(seq+1)%9007199254740992ULL;
                }
            }
        }
        ulTaskNotifyTake(pdTRUE,pdMS_TO_TICKS(200));
    }
}
void cloud_bridge_start(const DeviceConfig *cfg, cloud_snapshot_cb snapshot,
                        cloud_command_cb command, cloud_settings_cb settings, cloud_settings_cb automation) {
    if (!cfg->cloud_enabled || cloud_task_handle) return;
    if (!cloud_url_valid(cfg->cloud_url) || !cloud_token_valid(cfg->cloud_token) || !snapshot) {
        ESP_LOGW(TAG,"Cloud configuration incomplete"); return;
    }
    snprintf(uri,sizeof uri,"%s",cfg->cloud_url);
    snprintf(authorization,sizeof authorization,"Authorization: Bearer %s\r\n",cfg->cloud_token);
    get_snapshot=snapshot; dispatch_command=command; get_settings=settings; get_automation=automation;
    incoming_commands=xQueueCreate(4,sizeof(CloudCommand));
    completed_commands=xQueueCreate(4,sizeof(CloudCompletion));
    if (!incoming_commands || !completed_commands) {
        if (incoming_commands) vQueueDelete(incoming_commands);
        if (completed_commands) vQueueDelete(completed_commands);
        incoming_commands=completed_commands=NULL; return;
    }
    history_acks=xQueueCreate(4,37);
    history_mutex=xSemaphoreCreateMutex();
    if (!history_acks || !history_mutex) {
        if(history_acks) vQueueDelete(history_acks);
        if(history_mutex) vSemaphoreDelete(history_mutex);
        vQueueDelete(incoming_commands); vQueueDelete(completed_commands); incoming_commands=completed_commands=NULL; return;
    }
    signals=xEventGroupCreate();
    if (!signals) { vQueueDelete(history_acks); vSemaphoreDelete(history_mutex); vQueueDelete(incoming_commands); vQueueDelete(completed_commands); incoming_commands=completed_commands=NULL; return; }
    if (xTaskCreate(cloud_task,"cloud_bridge",12288,NULL,2,&cloud_task_handle)!=pdPASS) {
        vEventGroupDelete(signals); signals=NULL;
        vQueueDelete(history_acks); vSemaphoreDelete(history_mutex);
        vQueueDelete(incoming_commands); vQueueDelete(completed_commands); incoming_commands=completed_commands=NULL;
        return;
    }
    if (xTaskCreate(history_sampler,"history_sample",3072,NULL,1,NULL)!=pdPASS)
        ESP_LOGE(TAG,"History sampler task allocation failed; history is unavailable");
}
