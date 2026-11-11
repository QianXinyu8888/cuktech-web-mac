#include "cloud_protocol.h"
#include "cloud_history.h"
#include "miot_protocol.h"
#include <assert.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include "cJSON.h"
static int allocation_count, allocation_limit;
static void *failing_alloc(size_t size) { return allocation_count++ == allocation_limit ? NULL : malloc(size); }
int main(void) {
    assert(cloud_url_valid("wss://example.workers.dev/api/device"));
    assert(!cloud_url_valid("ws://example/api/device"));
    assert(!cloud_url_valid("wss://user:password@example/api/device"));
    assert(!cloud_url_valid("wss://example/api/device?token=secret"));
    assert(!cloud_token_valid("secret\r\nX: injected"));
    assert(cloud_token_valid("device-token_123"));
    char token[32] = "original";
    assert(cloud_update_token(token, sizeof token, "****"));
    assert(strcmp(token, "original") == 0);
    assert(!cloud_update_token(token, sizeof token, "bad\r\n"));
    assert(strcmp(token, "original") == 0);
    assert(cloud_update_token(token, sizeof token, "new-token"));
    assert(strcmp(token, "new-token") == 0);
    assert(cloud_update_token(token, sizeof token, ""));
    assert(!token[0]);
    assert(cloud_parse_rate("{\"type\":\"rate\",\"intervalMs\":1000}", 33) == 1000);
    const char *slow="{\"type\":\"rate\",\"intervalMs\":30000}";
    assert(cloud_parse_rate(slow, strlen(slow)) == 30000);
    assert(cloud_parse_rate("{\"type\":\"rate\",\"intervalMs\":999}", 32) == 0);
    assert(cloud_parse_rate("{\"type\":\"control\",\"intervalMs\":1000}", 36) == 0);
    CloudRx rx = {0};
    assert(!cloud_rx_append(&rx, slow, 12, 0, strlen(slow)));
    assert(cloud_rx_append(&rx, slow+12, strlen(slow)-12, 12, strlen(slow)));
    assert(cloud_parse_rate(rx.data, rx.length) == 30000);
    assert(!cloud_rx_append(&rx, "x", 1, 200, 201));
    assert(!cloud_rx_append(&rx, "x", 1, 0, 9999));
    memset(&rx, 0, sizeof rx);
    assert(!cloud_rx_frame(&rx, 1, false, slow, 8, 0, 8));
    assert(cloud_rx_frame(&rx, 0, true, slow+8, strlen(slow)-8, 0, strlen(slow)-8));
    assert(cloud_parse_rate(rx.data, rx.length) == 30000);
    assert(!cloud_rx_frame(&rx, 0, true, slow, strlen(slow), 0, strlen(slow)));
    CloudSnapshot snapshot={.uptime_ms=1234, .ble_connected=false};
    snapshot.ports[0]=(CloudPort){.voltage=20,.current=2,.power=40,.active=true,.valid=true};
    strcpy(snapshot.ports[0].protocol,"PD");
    char out[2048];
    snapshot.ble_phase="scanning";
    assert(cloud_format_telemetry(&snapshot, 0, out, sizeof out));
    assert(strstr(out,"\"blePhase\":\"scanning\""));
    assert(strstr(out,"\"valid\":true"));
    assert(strstr(out,"\"valid\":false"));
    assert(strstr(out,"\"id\":\"a\""));
    assert(!strstr(out,"token"));
    for (allocation_limit=0; allocation_limit<110; ++allocation_limit) {
        allocation_count=0;
        cJSON_Hooks hooks={failing_alloc,free}; cJSON_InitHooks(&hooks);
        bool ok=cloud_format_telemetry(&snapshot, 1, out, sizeof out);
        cJSON_InitHooks(NULL);
        if (allocation_count>allocation_limit) assert(!ok);
    }
    snapshot.ports[0].voltage=NAN;
    assert(!cloud_format_telemetry(&snapshot, 1, out, sizeof out));
    uint32_t mask;
    assert(!cloud_port_mask(0,true,false,15,&mask));
    assert(cloud_port_mask(4,false,false,15,&mask) && mask==0);
    assert(cloud_port_mask(4,true,false,0,&mask) && mask==15);
    assert(cloud_port_mask(1,false,true,15,&mask) && mask==13);
    assert(cloud_sample_new(1,0,10,10));
    assert(!cloud_sample_new(1,1,10,11));
    assert(!cloud_sample_new(2,1,10,41));
    CloudCommand command;
    const char *valid="{\"type\":\"command\",\"id\":\"12345678-1234-4234-8234-123456789abc\",\"issuedAt\":1704067200000,\"expiresAt\":1704067210000,\"action\":\"set\",\"params\":{\"piid\":21,\"value\":4294967295}}";
    assert(cloud_parse_command(valid, strlen(valid),1704067200100ULL,&command));
    assert(command.action==CLOUD_ACTION_SET && command.piid==21 && command.value==UINT32_MAX);
    assert(!cloud_parse_command(valid,strlen(valid),1704067210000ULL,&command));
    assert(!cloud_parse_command(valid,strlen(valid),1704067190000ULL,&command));
    assert(cloud_setting_valid(5,4)); assert(!cloud_setting_valid(5,0));
    assert(!cloud_setting_valid(7,1)); assert(!cloud_setting_valid(9,1441));
    const char *auto_params="{\"chargeLimits\":{\"c1\":{\"wh\":12.5,\"mode\":\"always\"},\"c2\":{\"wh\":0,\"mode\":\"once\"},\"c3\":{\"wh\":0,\"mode\":\"once\"},\"a\":{\"wh\":0,\"mode\":\"once\"}},\"permanent\":[\"c2\"],\"fullOff\":{\"c3\":\"once\"}}";
    char automation_cmd[768];
    snprintf(automation_cmd,sizeof automation_cmd,"{\"type\":\"command\",\"id\":\"12345678-1234-4234-8234-123456789abc\",\"issuedAt\":1704067200000,\"expiresAt\":1704067210000,\"action\":\"automation\",\"params\":%s}",auto_params);
    assert(cloud_parse_command(automation_cmd,strlen(automation_cmd),1704067200100ULL,&command));
    assert(command.action==CLOUD_ACTION_AUTOMATION && command.automation.ports[0].limit_wh==12.5f);
    assert(command.automation.ports[1].permanent && command.automation.ports[2].full_mode==AUTO_ONCE);
    static AutoEngine auto_engine;
    auto_engine_init(&auto_engine,&command.automation);
    auto_engine.ports[0].charging=true; auto_engine.ports[0].session_duration=120; auto_engine.ports[0].session_wh=0.6f;
    assert(cloud_format_automation(&auto_engine,out,1024));
    cJSON *auto_json=cJSON_Parse(out); assert(auto_json);
    assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(auto_json,"chargeLimits"))==4);
    assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(auto_json,"permanent"))==1);
    assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(auto_json,"fullOff"))==1);
    cJSON *progress=cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(auto_json,"chargeLimits"),"c1");
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(progress,"charging")));
    assert(cJSON_GetObjectItemCaseSensitive(progress,"sessionSec")->valueint==120);
    assert(fabs(cJSON_GetObjectItemCaseSensitive(progress,"avgPowerW")->valuedouble-18.0)<0.01);
    cJSON_Delete(auto_json);
    for (allocation_limit=0; allocation_limit<110; ++allocation_limit) {
        allocation_count=0; cJSON_Hooks hooks={failing_alloc,free}; cJSON_InitHooks(&hooks);
        bool ok=cloud_format_automation(&auto_engine,out,sizeof out);
        cJSON_InitHooks(NULL); if(allocation_count>allocation_limit) assert(!ok);
    }
    char *invalid=strstr(automation_cmd,"\"permanent\":[\"c2\"]"); assert(invalid);
    memcpy(invalid+14,"c1",2); /* permanent c1 conflicts with its nonzero limit */
    assert(!cloud_parse_command(automation_cmd,strlen(automation_cmd),1704067200100ULL,&command));
    auto_engine.config.ports[1].limit_wh=1; assert(!cloud_format_automation(&auto_engine,out,sizeof out));
    CloudCommandGate gate={0};
    assert(cloud_parse_command(valid,strlen(valid),1704067200100ULL,&command));
    assert(cloud_command_record(&gate,&command,1704067200100ULL)==1);
    assert(cloud_command_record(&gate,&command,1704067200100ULL)==0);
    uint8_t response[8]={0,0,42,0,1,0,0,16};
    assert(!cloud_set_response_matches(42,16,response,sizeof response)); /* ACK is not a SET result */
    assert(!miot_set_ack_matches(42,16,response,sizeof response));
    response[6]=2;
    assert(miot_set_ack_matches(42,16,response,sizeof response));
    assert(!miot_set_ack_matches(41,16,response,sizeof response));
    assert(!miot_set_ack_matches(42,6,response,sizeof response));
    assert(!miot_set_ack_matches(42,16,response,sizeof response-1));
    response[4]=4;
    assert(!miot_set_ack_matches(42,16,response,sizeof response));
    response[6]=0;
    assert(!cloud_set_response_matches(42,16,response,sizeof response));
    response[6]=2;
    assert(cloud_set_response_matches(42,16,response,sizeof response));
    assert(!cloud_set_response_matches(41,16,response,sizeof response));
    assert(!cloud_set_response_matches(42,21,response,sizeof response));
    assert(!cloud_set_response_matches(42,16,response,7));
    uint8_t encrypted[] = {0x7a, 0x00, 0xa1, 0xb2};
    uint8_t frame[6] = {0};
    assert(miot_command_frame(frame,sizeof frame,encrypted,sizeof encrypted)==sizeof frame);
    assert(!memcmp(frame,(uint8_t[]){0x01,0x00,0x7a,0x00,0xa1,0xb2},sizeof frame));
    assert(!miot_command_frame(frame,sizeof frame-1,encrypted,sizeof encrypted));
    uint8_t get[] = {17,0x20,42,0,3,1,2,16,0,0,0,1,0x10,13};
    uint32_t read_value=0;
    assert(miot_get_response_value(42,16,get,sizeof get,&read_value) && read_value==13);
    assert(!miot_get_response_value(41,16,get,sizeof get,&read_value));
    assert(!miot_get_response_value(42,21,get,sizeof get,&read_value));
    assert(!miot_get_response_value(42,16,get,sizeof get-1,&read_value));
    get[9]=1;
    assert(!miot_get_response_value(42,16,get,sizeof get,&read_value));
    uint8_t echo[] = {17,0x20,42,0,4,1,2,21,0,0,0,4,0x50,0x0f,0x0f,0x03,0x81};
    assert(miot_response_value(echo,sizeof echo,&read_value) && read_value==0x81030f0fU);
    assert(!miot_response_value(echo,sizeof echo-1,&read_value));
    const struct { const char *action; const char *params; bool ok; } cases[]={
        {"port","{\"port\":\"all\",\"action\":\"off\"}",true},
        {"port","{\"port\":\"c3\",\"action\":\"toggle\"}",false},
        {"port","{\"port\":\"c9\",\"action\":\"on\"}",false},
        {"ble","{\"enabled\":true}",true},
        {"ble","{\"enabled\":1}",false},
        {"set","{\"piid\":5,\"value\":0}",false},
        {"set","{\"piid\":9,\"value\":1441}",false},
        {"set","{\"piid\":7,\"value\":1}",false},
        {"set","{\"piid\":21,\"value\":4294967296}",false},
        {"set","{\"piid\":21,\"value\":-1}",false},
        {"set","{\"piid\":21,\"value\":1.5}",false},
        {"set","{\"piid\":21,\"value\":true}",false},
        {"set","{\"piid\":21,\"value\":1,\"extra\":0}",false},
        {"exec","{\"code\":\"anything\"}",false},
    };
    for(size_t i=0;i<sizeof cases/sizeof cases[0];++i) {
        char json[768];
        snprintf(json,sizeof json,"{\"type\":\"command\",\"id\":\"12345678-1234-4234-8234-123456789abc\",\"issuedAt\":1704067200000,\"expiresAt\":1704067210000,\"action\":\"%s\",\"params\":%s}",cases[i].action,cases[i].params);
        assert(cloud_parse_command(json,strlen(json),1704067200100ULL,&command)==cases[i].ok);
    }
    memset(&gate,0,sizeof gate);
    for(int i=0;i<64;++i) {
        snprintf(command.id,sizeof command.id,"%08x-1234-4234-8234-123456789abc",i);
        command.expires_at=10000;
        assert(cloud_command_record(&gate,&command,100)==1);
    }
    strcpy(command.id,"ffffffff-1234-4234-8234-123456789abc");
    assert(cloud_command_record(&gate,&command,100)==-1);
    assert(cloud_command_record(&gate,&command,10000)==1);
    CloudSettings settings={.device_model="test-model",.firmware_version="test-version",.protocol_extend=50335503};
    settings.valid[5]=settings.valid[17]=settings.valid[21]=true;
    settings.values[5]=2; settings.values[17]=1234; settings.values[21]=50335503;
    assert(cloud_format_settings(&settings,out,sizeof out));
    cJSON *event=cJSON_Parse(out); assert(event && cJSON_GetArraySize(event)==6);
    cJSON *values=cJSON_GetObjectItem(event,"settings");
    assert(cJSON_IsObject(values) && cJSON_GetArraySize(values)==2);
    assert(cJSON_GetObjectItem(values,"5")->valuedouble==2);
    assert(!cJSON_GetObjectItem(values,"17"));
    cJSON_Delete(event);
    CloudHistoryQueue history={0}; CloudHistorySample sample, first;
    snapshot.ports[0].voltage=20; snapshot.ble_connected=true;
    assert(cloud_history_pack(&snapshot,1704067200,&sample));
    for(unsigned i=0;i<CLOUD_HISTORY_CAPACITY;++i) { sample.timestamp=1704067200+i; assert(cloud_history_push(&history,&sample)); }
    assert(!cloud_history_push(&history,&sample) && history.dropped==1);
    assert(cloud_history_peek(&history,0,&first) && first.timestamp==1704067200);
    assert(cloud_history_format_sample(&first,out,sizeof out));
    assert(!strstr(out,"enabled"));
    snapshot.ports[0].enabled_known=true; snapshot.ports[0].enabled=false;
    assert(cloud_history_pack(&snapshot,1704067200,&sample));
    assert(cloud_history_format_sample(&sample,out,sizeof out));
    assert(strstr(out,"\"enabled\":false"));
    event=cJSON_Parse(out); assert(event && cJSON_GetArraySize(event)==2); cJSON_Delete(event);
    assert(!cloud_history_discard(&history,301));
    CloudHistoryFlight flight={0};
    /* Keep a retryable batch small enough for slow mobile connections. */
    assert(CLOUD_HISTORY_BATCH_MAX <= 5);
    assert(cloud_history_begin_batch(&history,&flight,"12345678-1234-4234-8234-123456789abc"));
    assert(flight.count==CLOUD_HISTORY_BATCH_MAX);
    char batch[8192];
    assert(cloud_history_format_batch(&history,flight.id,flight.count,batch,sizeof batch));
    event=cJSON_Parse(batch);assert(event);
    assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(event,"samples"))==CLOUD_HISTORY_BATCH_MAX);
    cJSON_Delete(event);
    assert(!cloud_history_format_batch(&history,flight.id,flight.count,batch,16));
    assert(!cloud_history_ack_batch(&history,&flight,"ffffffff-1234-4234-8234-123456789abc"));
    assert(history.count==300 && flight.count==CLOUD_HISTORY_BATCH_MAX);
    assert(cloud_history_ack_batch(&history,&flight,"12345678-1234-4234-8234-123456789abc") && history.count==300-CLOUD_HISTORY_BATCH_MAX);
    assert(!cloud_history_ack_batch(&history,&flight,"12345678-1234-4234-8234-123456789abc"));
    assert(cloud_history_peek(&history,0,&first) && first.timestamp==1704067200+CLOUD_HISTORY_BATCH_MAX);
    snapshot.ble_connected=false; assert(cloud_history_pack(&snapshot,1704068000,&sample));
    assert(!(sample.ports[0].flags&2));
    char ack_id[37];
    const char *ack="{\"type\":\"history_ack\",\"id\":\"12345678-1234-4234-8234-123456789abc\",\"accepted\":0}";
    assert(cloud_parse_history_ack(ack,strlen(ack),ack_id));
    assert(!strcmp(ack_id,"12345678-1234-4234-8234-123456789abc"));
    puts("cloud protocol/config/history tests passed");
}
