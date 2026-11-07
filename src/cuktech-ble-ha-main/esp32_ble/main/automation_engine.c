#include "automation_engine.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

bool auto_config_valid(const AutoConfig *config) {
 if(!config)return false;
 for(unsigned i=0;i<4;++i) {
  const AutoRule *r=&config->ports[i];
  if(!isfinite(r->limit_wh)||r->limit_wh<0||r->limit_wh>1000||
    (r->limit_mode!=AUTO_ONCE&&r->limit_mode!=AUTO_ALWAYS)||r->full_mode>AUTO_ALWAYS||
    (r->permanent&&(r->limit_wh>0||r->full_mode)))return false;
 }
 return true;
}
static void reset_windows(AutoPortState *p) {
 p->head=p->count=0; p->above_since=p->hold_since=p->no_load_since=p->last_eval=AUTO_NONE; p->grace=0;
}
void auto_engine_init(AutoEngine *e,const AutoConfig *config) {
 memset(e,0,sizeof(*e));
 for(unsigned i=0;i<4;++i) { e->config.ports[i].limit_mode=AUTO_ONCE; e->ports[i].last_time=AUTO_NONE; reset_windows(&e->ports[i]); }
 if(auto_config_valid(config))e->config=*config;
}
void auto_engine_configure(AutoEngine *e,const AutoConfig *config) {
 if(!auto_config_valid(config))return;
 for(unsigned i=0;i<4;++i)if(e->config.ports[i].limit_wh!=config->ports[i].limit_wh ||
  e->config.ports[i].limit_mode!=config->ports[i].limit_mode || e->config.ports[i].full_mode!=config->ports[i].full_mode ||
  e->config.ports[i].permanent!=config->ports[i].permanent) {
  AutoPortState *p=&e->ports[i]; p->pending=p->inflight=p->fired=false; p->attempts=p->reason=0; p->error[0]=0;
 }
 e->config=*config;
}
static float threshold(float peak) { return fmaxf(0.05f,fminf(0.6f,0.2f*peak)); }
static int cmp_float(const void *a,const void *b) {float x=*(const float*)a,y=*(const float*)b;return (x>y)-(x<y);}
static float median(AutoEngine *e,AutoPortState *p,uint32_t since) {
 unsigned n=0;
 for(unsigned i=0;i<p->count;++i) { AutoPoint q=p->points[(p->head+i)%AUTO_WINDOW]; if(q.t>=since)e->scratch[n++]=q.power; }
 if(!n)return 0;
 qsort(e->scratch,n,sizeof(float),cmp_float);
 return n&1?e->scratch[n/2]:(e->scratch[n/2-1]+e->scratch[n/2])*0.5f;
}
static void append(AutoPortState *p,uint32_t t,float power) {
 while(p->count && (p->count==AUTO_WINDOW || t-p->points[p->head].t>300)) {p->head=(p->head+1)%AUTO_WINDOW;--p->count;}
 p->points[(p->head+p->count)%AUTO_WINDOW]=(AutoPoint){t,power}; ++p->count;
}
static float recovery(AutoPortState *p,uint32_t t,float limit) {
 float run=0,longest=0; uint32_t previous=AUTO_NONE;
 for(unsigned i=0;i<p->count;++i) {
  AutoPoint q=p->points[(p->head+i)%AUTO_WINDOW];
  if(t-q.t>90){previous=q.t;continue;}
  float dt=previous==AUTO_NONE?0:(float)(q.t-previous);previous=q.t;
  if(q.power>limit){run+=dt;if(run>longest)longest=run;}else run=0;
 }
 return longest;
}
static void arm(AutoPortState *p,uint32_t t,uint8_t reason) {
 if(p->pending || (reason==2&&p->attempts>=4))return;
 p->pending=true;p->reason=reason;p->retry_at=t;p->error[0]=0;
}
static void close_session(AutoPortState *p) {
 p->charging=false;p->post_session=true;p->restart_w=fmaxf(0.4f,2*threshold(p->peak));p->above_since=AUTO_NONE;
}
void auto_engine_feed(AutoEngine *e,unsigned index,uint32_t t,bool valid,float v,float a,bool active,bool known,bool enabled) {
 if(index>=4)return;
 AutoPortState *p=&e->ports[index];const AutoRule *r=&e->config.ports[index];
 if(!valid||!isfinite(v)||!isfinite(a)||v<0||a<0||!isfinite(v*a)) {
  p->last_time=AUTO_NONE;reset_windows(p);strcpy(p->error,"sample_unavailable");return;
 }
 if(p->last_time!=AUTO_NONE && t<=p->last_time)return;
 float power=v*a; uint32_t dt=p->last_time==AUTO_NONE?0:t-p->last_time;
 if(dt>30){reset_windows(p);dt=0;}
 if(p->charging && dt)p->session_wh+=(p->last_power+power)*0.5f*(float)dt/3600;
 p->last_time=t;p->last_power=power;
 if(!p->pending && !strcmp(p->error,"sample_unavailable"))p->error[0]=0;
 append(p,t,power);
 float fast=median(e,p,t>20?t-20:0),slow=median(e,p,t>180?t-180:0);
 if(fast>p->peak)p->peak=fast;
 if(p->charging) {
  if(known&&!enabled){close_session(p);return;}
  if(!active||a<=0) {
   if(p->no_load_since==AUTO_NONE)p->no_load_since=t;
   if(t-p->no_load_since>=15) {
    close_session(p);p->from_session=v>=4;
    if(v<4){p->post_session=false;p->no_load_since=AUTO_NONE;}
   }
  } else {
   p->no_load_since=AUTO_NONE;p->from_session=false;
   if(p->session_wh>=0.05f && t-p->session_start>=180) {
    float low=threshold(p->peak);bool converged=v>=4&&fast<=low&&slow<=low;
    if(recovery(p,t,fmaxf(5,2*low))>=45){p->hold_since=AUTO_NONE;p->grace=0;}
    else if(converged) {if(p->hold_since==AUTO_NONE){p->hold_since=t;p->grace=0;}}
    else if(p->hold_since!=AUTO_NONE) {p->grace+=(float)dt;if(p->grace>120){p->hold_since=AUTO_NONE;p->grace=0;}}
    if(p->hold_since!=AUTO_NONE&&t-p->hold_since>=600) {
     close_session(p);
     if(r->full_mode&&!r->permanent&&p->session_wh>=1)arm(p,t,2);
    }
   } else p->hold_since=AUTO_NONE;
  }
  if(p->charging&&!r->permanent&&r->limit_wh>0&&p->session_wh>=r->limit_wh)arm(p,t,1);
  return;
 }
 if(v<4&&a<=0){p->post_session=false;p->above_since=AUTO_NONE;p->no_load_since=AUTO_NONE;p->peak=0;p->fired=false;}
 if(power>2){p->no_load_since=AUTO_NONE;p->from_session=false;}
 else if(r->full_mode&&!r->permanent&&!p->fired&&!(known&&!enabled)&&v>=4) {
  if(p->no_load_since==AUTO_NONE)p->no_load_since=t;
  if(t-p->no_load_since>=(p->from_session?120U:600U))arm(p,t,2);
 }
 float start=fmaxf(0.5f,0.1f*v);if(p->post_session)start=fmaxf(start,p->restart_w);
 if(!active||(known&&!enabled)||fast<start){p->above_since=AUTO_NONE;return;}
 if(p->above_since==AUTO_NONE)p->above_since=t;
 if(t-p->above_since<30)return;
 p->charging=true;p->session_start=p->above_since;p->session_wh=0;p->post_session=false;p->peak=fast;
 p->pending=p->inflight=p->fired=false;p->attempts=p->reason=0;p->error[0]=0;
 AutoPoint previous={0};bool have=false;
 for(unsigned i=0;i<p->count;++i) {
  AutoPoint q=p->points[(p->head+i)%AUTO_WINDOW];if(q.t<p->above_since)continue;
  if(have && q.t-previous.t<=30)p->session_wh+=(q.power+previous.power)*0.5f*(q.t-previous.t)/3600;
  previous=q;have=true;
 }
 p->above_since=AUTO_NONE;p->hold_since=AUTO_NONE;p->grace=0;
 if(!r->permanent&&r->limit_wh>0&&p->session_wh>=r->limit_wh)arm(p,t,1);
}
bool auto_engine_take_off(AutoEngine *e,unsigned i,uint32_t t) {
 if(i>=4)return false;
 AutoPortState *p=&e->ports[i];
 if(!p->pending||p->inflight||p->last_time==AUTO_NONE||t<p->last_time||t-p->last_time>30||t<p->retry_at||e->config.ports[i].permanent)return false;
 if(p->reason==2&&p->attempts>=4){p->pending=false;strcpy(p->error,"off_unconfirmed");return false;}
 p->inflight=true;++p->attempts;p->retry_at=t+15;return true;
}
bool auto_engine_result(AutoEngine *e,unsigned i,uint32_t t,bool success) {
 if(i>=4)return false;
 AutoPortState *p=&e->ports[i];AutoRule *r=&e->config.ports[i];
 if(!p->inflight)return false;
 p->inflight=false;
 if(!success){p->retry_at=t+15;strcpy(p->error,"ble_off_failed");return false;}
 bool consumed=false;p->pending=false;p->fired=true;p->error[0]=0;close_session(p);
 if(p->reason==1&&r->limit_mode==AUTO_ONCE){r->limit_wh=0;consumed=true;}
 if(p->reason==2&&r->full_mode==AUTO_ONCE){r->full_mode=AUTO_DISABLED;consumed=true;}
 return consumed;
}

bool auto_restart_paused(const AutoRule *previous,const AutoRule *next,bool paused) {
 if (!paused || !previous || !next || next->limit_wh<=0)return false;
 return previous->limit_wh==next->limit_wh && previous->limit_mode==next->limit_mode;
}
void auto_engine_reset_port(AutoEngine *e,unsigned index) {
 if(!e || index>=4)return;
 AutoPortState *p=&e->ports[index];memset(p,0,sizeof *p);p->last_time=AUTO_NONE;reset_windows(p);
}
