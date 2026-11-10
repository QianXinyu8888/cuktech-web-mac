#include "cloud_protocol.h"
#include "cJSON.h"
#include <string.h>
#include <math.h>
#include <stdio.h>

bool cloud_url_valid(const char *url) {
    if (!url || strncmp(url,"wss://",6) || !url[6]) return false;
    const char *path=strchr(url+6,'/');
    if (!path || path==url+6 || strcmp(path,"/api/device")) return false;
    for (const char *p=url; *p; ++p)
        if ((unsigned char)*p <= 32 || *p=='@' || *p=='?' || *p=='#' || *p=='\\') return false;
    return true;
}
bool cloud_token_valid(const char *token) {
    if (!token || !*token) return false;
    for (; *token; ++token) {
        unsigned char c=(unsigned char)*token;
        if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||strchr("-._~+/=",c))) return false;
    }
    return true;
}
bool cloud_update_token(char *dest, size_t capacity, const char *value) {
    if (!dest || !value || !capacity) return false;
    if (strstr(value,"****")) return true;
    if (strlen(value)>=capacity || (*value && !cloud_token_valid(value))) return false;
    strcpy(dest,value);
    return true;
}
int cloud_parse_rate(const char *json, size_t length) {
    if (!json || !length || length>=256 || memchr(json,0,length)) return 0;
    char copy[256]; memcpy(copy,json,length); copy[length]=0;
    cJSON *root=cJSON_ParseWithOpts(copy,NULL,true);
    if (!root) return 0;
    cJSON *type=cJSON_GetObjectItemCaseSensitive(root,"type");
    cJSON *rate=cJSON_GetObjectItemCaseSensitive(root,"intervalMs");
    int interval=0;
    if (cJSON_IsObject(root) && cJSON_GetArraySize(root)==2 && cJSON_IsString(type) && !strcmp(type->valuestring,"rate") &&
        cJSON_IsNumber(rate) && (rate->valuedouble==1000 || rate->valuedouble==30000)) interval=(int)rate->valuedouble;
    cJSON_Delete(root); return interval;
}
bool cloud_rx_append(CloudRx *rx, const char *data, size_t length, size_t offset, size_t total) {
    if (!offset) { rx->length=0; rx->total=total; }
    if (!total || total>=sizeof rx->data || offset!=rx->length || total!=rx->total || length>total-offset) {
        rx->length=rx->total=0; return false;
    }
    memcpy(rx->data+offset,data,length); rx->length+=length; rx->data[rx->length]=0;
    return rx->length==total;
}
bool cloud_format_telemetry(const CloudSnapshot *s, uint64_t seq, char *out, size_t capacity) {
    static const char *ids[]={"c1","c2","c3","a"};
    if (!s || seq>9007199254740991ULL) return false;
    for (int i=0;i<4;++i)
        if (!isfinite(s->ports[i].voltage)||!isfinite(s->ports[i].current)||!isfinite(s->ports[i].power) ||
            s->ports[i].voltage<0 || s->ports[i].current<0 || s->ports[i].power<0) return false;
    cJSON *root=cJSON_CreateObject();
    if (!root) return false;
    cJSON_AddStringToObject(root,"type","telemetry"); cJSON_AddNumberToObject(root,"version",1);
    cJSON_AddNumberToObject(root,"seq",seq); cJSON_AddNumberToObject(root,"uptimeMs",s->uptime_ms);
    cJSON_AddBoolToObject(root,"bleConnected",s->ble_connected);
    cJSON *ports=cJSON_AddArrayToObject(root,"ports");
    if (!ports || cJSON_GetArraySize(root)!=6) { cJSON_Delete(root); return false; }
    for (int i=0;i<4;++i) {
        const CloudPort *p=&s->ports[i]; cJSON *port=cJSON_CreateObject();
        if (!port || !ports) { cJSON_Delete(port); cJSON_Delete(root); return false; }
        cJSON_AddItemToArray(ports,port); cJSON_AddStringToObject(port,"id",ids[i]);
        cJSON_AddNumberToObject(port,"voltage",p->voltage); cJSON_AddNumberToObject(port,"current",p->current);
        cJSON_AddNumberToObject(port,"power",p->power); cJSON_AddBoolToObject(port,"active",p->active);
        cJSON_AddBoolToObject(port,"valid",p->valid); cJSON_AddStringToObject(port,"protocol",p->protocol);
        if (cJSON_GetArraySize(port)!=7) { cJSON_Delete(root); return false; }
    }
    bool ok=cJSON_PrintPreallocated(root,out,capacity,false); cJSON_Delete(root); return ok;
}

/* Assemble both client-buffer chunks and RFC6455 continuation frames. */
bool cloud_rx_frame(CloudRx *rx, int opcode, bool fin, const char *data, size_t length, size_t offset, size_t frame_length) {
    if (opcode >= 8) return false; /* ping/pong may interleave with text */
    if (opcode == 1 && offset == 0) {
        rx->length = rx->frame_offset = 0; rx->accepting = true;
    }
    if (!rx->accepting || (opcode != 1 && opcode != 0) || offset != rx->frame_offset ||
        offset > frame_length || length > frame_length-offset || length >= sizeof(rx->data)-rx->length) {
        rx->accepting = false; rx->length = rx->frame_offset = 0; return false;
    }
    memcpy(rx->data + rx->length, data, length); rx->length += length;
    rx->frame_offset += length; rx->data[rx->length] = 0;
    if (rx->frame_offset == frame_length) {
        rx->frame_offset = 0;
        if (fin) { rx->accepting = false; return true; }
    }
    return false;
}

bool cloud_setting_valid(uint8_t piid, uint32_t value) {
    switch (piid) {
        case 5: return value>=1 && value<=4;
        case 6: return value<=5;
        case 8: case 9: case 10: case 11: case 12: return value<=1440;
        case 13: case 15: case 19: case 20: return value<=1;
        case 16: return value<=15;
        case 21: return true;
        default: return false;
    }
}
static bool uuid_v4(const char *id) {
    if (!id || strlen(id)!=36 || id[14]!='4' || !strchr("89abAB",id[19])) return false;
    for (int i=0;i<36;++i) {
        if (i==8 || i==13 || i==18 || i==23) { if (id[i]!='-') return false; }
        else if (!strchr("0123456789abcdefABCDEF",id[i])) return false;
    }
    return true;
}
static bool json_uint(cJSON *item, double max) {
    return cJSON_IsNumber(item) && isfinite(item->valuedouble) && item->valuedouble>=0 &&
        item->valuedouble<=max && floor(item->valuedouble)==item->valuedouble;
}
static const char *auto_names[4]={"c1","c2","c3","a"};
static bool parse_mode(const cJSON *item, uint8_t *out) {
    if (!cJSON_IsString(item)) return false;
    if (!strcmp(item->valuestring,"once")) *out=AUTO_ONCE;
    else if (!strcmp(item->valuestring,"always")) *out=AUTO_ALWAYS;
    else return false;
    return true;
}
static int auto_index(const char *name) {
    for(int i=0;i<4;i++) if(name && !strcmp(name,auto_names[i])) return i;
    return -1;
}
static bool parse_automation(const cJSON *params, AutoConfig *config) {
    cJSON *limits=cJSON_GetObjectItemCaseSensitive(params,"chargeLimits");
    cJSON *permanent=cJSON_GetObjectItemCaseSensitive(params,"permanent");
    cJSON *full=cJSON_GetObjectItemCaseSensitive(params,"fullOff");
    if(cJSON_GetArraySize(params)!=3 || !cJSON_IsObject(limits) || cJSON_GetArraySize(limits)!=4 ||
       !cJSON_IsArray(permanent) || !cJSON_IsObject(full) || cJSON_GetArraySize(permanent)>4 || cJSON_GetArraySize(full)>4) return false;
    AutoConfig cfg={0};
    for(int i=0;i<4;i++) {
        cJSON *item=cJSON_GetObjectItemCaseSensitive(limits,auto_names[i]);
        cJSON *wh=cJSON_GetObjectItemCaseSensitive(item,"wh"), *mode=cJSON_GetObjectItemCaseSensitive(item,"mode");
        if(!cJSON_IsObject(item)||cJSON_GetArraySize(item)!=2||!cJSON_IsNumber(wh)||!isfinite(wh->valuedouble)||wh->valuedouble<0||wh->valuedouble>1000||!parse_mode(mode,&cfg.ports[i].limit_mode)) return false;
        cfg.ports[i].limit_wh=(float)wh->valuedouble;
    }
    cJSON *entry;
    cJSON_ArrayForEach(entry,permanent) { int i=cJSON_IsString(entry)?auto_index(entry->valuestring):-1; if(i<0||cfg.ports[i].permanent)return false;cfg.ports[i].permanent=true; }
    cJSON_ArrayForEach(entry,full) { int i=auto_index(entry->string); if(i<0||cfg.ports[i].full_mode||!parse_mode(entry,&cfg.ports[i].full_mode))return false; }
    if(!auto_config_valid(&cfg))return false;
    *config=cfg;return true;
}
bool cloud_parse_command(const char *json, size_t length, uint64_t now_ms, CloudCommand *command) {
    if (!json || !length || length>=768 || memchr(json,0,length)) return false;
    char copy[768]; memcpy(copy,json,length); copy[length]=0;
    cJSON *root=cJSON_ParseWithOpts(copy,NULL,true);
    if (!root) return false;
    cJSON *type=cJSON_GetObjectItemCaseSensitive(root,"type"), *id=cJSON_GetObjectItemCaseSensitive(root,"id");
    cJSON *issued=cJSON_GetObjectItemCaseSensitive(root,"issuedAt"), *expires=cJSON_GetObjectItemCaseSensitive(root,"expiresAt");
    cJSON *action=cJSON_GetObjectItemCaseSensitive(root,"action"), *params=cJSON_GetObjectItemCaseSensitive(root,"params");
    bool ok=cJSON_IsObject(root) && cJSON_GetArraySize(root)==6 && cJSON_IsString(type) && !strcmp(type->valuestring,"command") &&
        cJSON_IsString(id) && uuid_v4(id->valuestring) && cJSON_IsString(action) && cJSON_IsObject(params) &&
        json_uint(issued,9007199254740991.0) && json_uint(expires,9007199254740991.0);
    CloudCommand cmd={0};
    if (ok) ok=issued->valuedouble<=now_ms+1000 && expires->valuedouble>now_ms &&
        expires->valuedouble>issued->valuedouble && expires->valuedouble-issued->valuedouble<=10000;
    if (ok) {
        strcpy(cmd.id,id->valuestring); cmd.expires_at=(uint64_t)expires->valuedouble;
        if (!strcmp(action->valuestring,"set")) {
            cJSON *piid=cJSON_GetObjectItemCaseSensitive(params,"piid"), *value=cJSON_GetObjectItemCaseSensitive(params,"value");
            ok=cJSON_GetArraySize(params)==2 && json_uint(piid,31) && json_uint(value,UINT32_MAX);
            if (ok) { cmd.action=CLOUD_ACTION_SET; cmd.piid=(uint8_t)piid->valuedouble; cmd.value=(uint32_t)value->valuedouble; ok=cloud_setting_valid(cmd.piid,cmd.value); }
        } else if (!strcmp(action->valuestring,"port")) {
            cJSON *port=cJSON_GetObjectItemCaseSensitive(params,"port"), *a=cJSON_GetObjectItemCaseSensitive(params,"action");
            ok=cJSON_GetArraySize(params)==2 && cJSON_IsString(port) && cJSON_IsString(a) && (!strcmp(a->valuestring,"on") || !strcmp(a->valuestring,"off"));
            if (ok) {
                static const char *names[]={"c1","c2","c3","a","all"}; int index=-1;
                for (int i=0;i<5;++i) if (!strcmp(port->valuestring,names[i])) index=i;
                ok=index>=0; cmd.action=CLOUD_ACTION_PORT; cmd.piid=index; cmd.value=!strcmp(a->valuestring,"on");
            }
        } else if (!strcmp(action->valuestring,"ble")) {
            cJSON *enabled=cJSON_GetObjectItemCaseSensitive(params,"enabled");
            ok=cJSON_GetArraySize(params)==1 && cJSON_IsBool(enabled);
            cmd.action=CLOUD_ACTION_BLE; cmd.value=cJSON_IsTrue(enabled);
        } else if (!strcmp(action->valuestring,"automation")) {
            cmd.action=CLOUD_ACTION_AUTOMATION; ok=parse_automation(params,&cmd.automation);
        } else ok=false;
    }
    if (ok) *command=cmd;
    cJSON_Delete(root); return ok;
}
int cloud_command_record(CloudCommandGate *gate, const CloudCommand *command, uint64_t now_ms) {
    int free_slot=-1;
    for (int i=0;i<64;++i) {
        if (gate->seen[i].expires_at<=now_ms) { if (free_slot<0) free_slot=i; }
        else if (!strcmp(gate->seen[i].id,command->id)) return 0;
    }
    if (free_slot<0) return -1;
    strcpy(gate->seen[free_slot].id,command->id); gate->seen[free_slot].expires_at=command->expires_at;
    return 1;
}
bool cloud_set_response_matches(uint8_t seq, uint8_t piid, const uint8_t *response, size_t length) {
    return response && length>=8 && response[2]==seq && response[4]==0x04 && response[6]==2 && response[7]==piid;
}
bool cloud_format_settings(const CloudSettings *settings, char *out, size_t capacity) {
    if (!settings || !settings->device_model || !settings->firmware_version ||
        strlen(settings->device_model)>64 || strlen(settings->firmware_version)>64) return false;
    cJSON *root=cJSON_CreateObject();
    if (!root) return false;
    cJSON_AddStringToObject(root,"type","settings"); cJSON_AddNumberToObject(root,"version",1);
    cJSON *items=cJSON_AddObjectToObject(root,"settings"); int count=0;
    for (int i=0;i<32;++i) if (settings->valid[i] && cloud_setting_valid(i,settings->values[i])) {
        char key[4]; snprintf(key,sizeof key,"%d",i);
        if (items) cJSON_AddNumberToObject(items,key,settings->values[i]);
        ++count;
    }
    cJSON_AddNumberToObject(root,"protocolExtend",settings->protocol_extend);
    cJSON_AddStringToObject(root,"deviceModel",settings->device_model);
    cJSON_AddStringToObject(root,"firmwareVersion",settings->firmware_version);
    bool ok=items && cJSON_GetArraySize(items)==count && cJSON_GetArraySize(root)==6 &&
        cJSON_PrintPreallocated(root,out,capacity,false);
    cJSON_Delete(root); return ok;
}
bool cloud_parse_history_ack(const char *json, size_t length, char id[37]) {
    if (!json || !length || length>=256 || memchr(json,0,length)) return false;
    char copy[256]; memcpy(copy,json,length); copy[length]=0;
    cJSON *root=cJSON_ParseWithOpts(copy,NULL,true);
    if (!root) return false;
    cJSON *type=cJSON_GetObjectItemCaseSensitive(root,"type"), *key=cJSON_GetObjectItemCaseSensitive(root,"id");
    cJSON *accepted=cJSON_GetObjectItemCaseSensitive(root,"accepted");
    bool ok=cJSON_IsObject(root) && cJSON_GetArraySize(root)==3 && cJSON_IsString(type) && !strcmp(type->valuestring,"history_ack") &&
        cJSON_IsString(key) && uuid_v4(key->valuestring) && json_uint(accepted,60);
    if(ok) strcpy(id,key->valuestring);
    cJSON_Delete(root); return ok;
}

bool cloud_format_automation(const AutoEngine *e, char *out, size_t capacity) {
    if(!e || !auto_config_valid(&e->config))return false;
    cJSON *root=cJSON_CreateObject(); if(!root)return false;
    cJSON_AddStringToObject(root,"type","automation_state"); cJSON_AddNumberToObject(root,"version",1);
    cJSON *limits=cJSON_AddObjectToObject(root,"chargeLimits");
    cJSON *permanent=cJSON_AddArrayToObject(root,"permanent"); cJSON *full=cJSON_AddObjectToObject(root,"fullOff");
    int permanent_count=0, full_count=0;
    for(int i=0;i<4 && limits && permanent && full;i++) {
        const AutoRule *r=&e->config.ports[i]; const AutoPortState *p=&e->ports[i];
        cJSON *item=cJSON_AddObjectToObject(limits,auto_names[i]);
        if(!item)continue;
        cJSON_AddNumberToObject(item,"wh",r->limit_wh); cJSON_AddStringToObject(item,"mode",r->limit_mode==AUTO_ALWAYS?"always":"once");
        cJSON_AddNumberToObject(item,"sessionWh",p->session_wh); cJSON_AddBoolToObject(item,"fired",p->fired);
        cJSON_AddBoolToObject(item,"pending",p->pending); cJSON_AddStringToObject(item,"error",p->error);
        cJSON_AddBoolToObject(item,"charging",p->charging);
        cJSON_AddNumberToObject(item,"sessionSec",p->session_duration);
        cJSON_AddNumberToObject(item,"avgPowerW",p->session_duration ? p->session_wh * 3600.0 / p->session_duration : 0);
        if(r->permanent) { ++permanent_count; cJSON_AddItemToArray(permanent,cJSON_CreateString(auto_names[i])); }
        if(r->full_mode) { ++full_count; cJSON_AddStringToObject(full,auto_names[i],r->full_mode==AUTO_ALWAYS?"always":"once"); }
    }
    bool ok=limits&&permanent&&full&&cJSON_GetArraySize(root)==5&&cJSON_GetArraySize(limits)==4 && cJSON_GetArraySize(permanent)==permanent_count && cJSON_GetArraySize(full)==full_count;
    if(ok) for(int i=0;i<4;i++) if(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(limits,auto_names[i]))!=9)ok=false;
    if(ok) ok=cJSON_PrintPreallocated(root,out,capacity,false);
    cJSON_Delete(root);
    return ok;
}

bool cloud_port_mask(uint8_t port,bool enabled,bool known,uint32_t current,uint32_t *result) {
    if(!result || port>4 || (port<4&&!known))return false;
    uint32_t mask=port==4?15U:(1U<<port);
    *result=port==4?(enabled?15U:0U):(enabled?(current&15U)|mask:(current&15U)&~mask);
    return true;
}
bool cloud_sample_new(uint32_t sequence,uint32_t previous,uint32_t sample_time,uint32_t now) {
    return sequence && sequence!=previous && now>=sample_time && now-sample_time<=30;
}
