#include "cloud_history.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static const char *const protocols[]={"idle","5V","QC","AFC","FCP","SCP","PD","PPS","UFCS","?"};
bool cloud_history_pack(const CloudSnapshot *snapshot, uint32_t timestamp, CloudHistorySample *sample) {
    if (timestamp<1704067200) return false;
    memset(sample,0,sizeof(*sample)); sample->timestamp=timestamp;
    for (int i=0;i<4;++i) {
        const CloudPort *port=&snapshot->ports[i];
        if (!isfinite(port->voltage)||!isfinite(port->current)||!isfinite(port->power)||
            port->voltage<0||port->voltage>100000||port->current<0||port->current>100000||port->power<0||port->power>100000) return false;
        CloudHistoryPort *p=&sample->ports[i];
        p->voltage=port->voltage; p->current=port->current; p->power=port->power;
        p->flags=(port->active?1:0)|((port->valid && snapshot->ble_connected)?2:0)|
            ((port->enabled_known && snapshot->ble_connected)?4:0)|(port->enabled?8:0);
        p->protocol=9;
        for(int j=0;j<10;++j) if(!strcmp(protocols[j],port->protocol)) p->protocol=j;
    }
    return true;
}
bool cloud_history_push(CloudHistoryQueue *queue, const CloudHistorySample *sample) {
    if(queue->count>=CLOUD_HISTORY_CAPACITY) { ++queue->dropped; return false; }
    queue->samples[(queue->head+queue->count)%CLOUD_HISTORY_CAPACITY]=*sample; ++queue->count;
    return true;
}
bool cloud_history_peek(const CloudHistoryQueue *queue, size_t offset, CloudHistorySample *sample) {
    if(offset>=queue->count) return false;
    *sample=queue->samples[(queue->head+offset)%CLOUD_HISTORY_CAPACITY]; return true;
}
bool cloud_history_discard(CloudHistoryQueue *queue, size_t count) {
    if(count>queue->count) return false;
    queue->head=(queue->head+count)%CLOUD_HISTORY_CAPACITY; queue->count-=count; return true;
}
bool cloud_history_format_sample(const CloudHistorySample *sample, char *out, size_t capacity) {
    static const char *ids[]={"c1","c2","c3","a"};
    int n=snprintf(out,capacity,"{\"timestamp\":%lu,\"ports\":[",(unsigned long)sample->timestamp);
    if(n<0 || (size_t)n>=capacity) return false;
    size_t used=n;
    for(int i=0;i<4;++i) {
        const CloudHistoryPort *p=&sample->ports[i];
        if(p->protocol>=10 || !isfinite(p->voltage)||!isfinite(p->current)||!isfinite(p->power)) return false;
        n=snprintf(out+used,capacity-used,
            "%s{\"id\":\"%s\",\"voltage\":%.9g,\"current\":%.9g,\"power\":%.9g,\"active\":%s,\"valid\":%s,\"protocol\":\"%s\"%s}",
            i?",":"",ids[i],(double)p->voltage,(double)p->current,(double)p->power,
            p->flags&1?"true":"false",p->flags&2?"true":"false",protocols[p->protocol],
            p->flags&4 ? (p->flags&8 ? ",\"enabled\":true" : ",\"enabled\":false") : "");
        if(n<0 || (size_t)n>=capacity-used) return false;
        used+=n;
    }
    n=snprintf(out+used,capacity-used,"]}"); return n>=0 && (size_t)n<capacity-used;
}
bool cloud_history_begin_batch(const CloudHistoryQueue *queue, CloudHistoryFlight *flight, const char *id) {
    if (flight->count || queue->count<CLOUD_HISTORY_BATCH_MAX || !id || strlen(id)!=36) return false;
    strcpy(flight->id,id); flight->count=CLOUD_HISTORY_BATCH_MAX; return true;
}
bool cloud_history_ack_batch(CloudHistoryQueue *queue, CloudHistoryFlight *flight, const char *ack_id) {
    if (!flight->count || !ack_id || strcmp(flight->id,ack_id) || !cloud_history_discard(queue,flight->count)) return false;
    flight->count=0; flight->id[0]=0; return true;
}
