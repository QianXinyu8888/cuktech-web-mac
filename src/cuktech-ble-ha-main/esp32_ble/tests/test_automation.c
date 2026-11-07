#include "automation_engine.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    static AutoEngine e;
    AutoConfig cfg={0};
    for (int i=0;i<4;i++) cfg.ports[i].limit_mode=AUTO_ONCE;
    cfg.ports[0].limit_wh=0.1f;
    assert(auto_config_valid(&cfg));
    auto_engine_init(&e,&cfg);
    for (unsigned t=1;t<=80;t++) auto_engine_feed(&e,0,t,true,5,2,true,false,false);
    assert(e.ports[0].pending);
    assert(!auto_engine_take_off(&e,0,111)); /* stale samples must never trigger a retry */
    auto_engine_feed(&e,0,112,false,0,0,false,false,false);
    assert(!auto_engine_take_off(&e,0,112));
    auto_engine_feed(&e,0,113,true,5,2,true,false,false);
    assert(auto_engine_take_off(&e,0,113));
    assert(!auto_engine_result(&e,0,114,false));
    assert(e.config.ports[0].limit_wh>0);
    auto_engine_feed(&e,0,130,true,5,2,true,false,false);
    assert(auto_engine_take_off(&e,0,130));
    assert(auto_engine_result(&e,0,131,true));
    assert(e.config.ports[0].limit_wh==0);
    /* A confirmed full-off must not continuously rearm while the load remains idle. */
    cfg.ports[0].limit_wh=0;
    cfg.ports[0].full_mode=AUTO_ALWAYS;
    auto_engine_init(&e,&cfg);
    for (unsigned t=1;t<=601;t++) auto_engine_feed(&e,0,t,true,5,0,true,true,true);
    assert(auto_engine_take_off(&e,0,601));
    assert(!auto_engine_result(&e,0,602,true));
    for (unsigned t=603;t<=1210;t++) auto_engine_feed(&e,0,t,true,5,0,true,true,false);
    assert(!e.ports[0].pending);
    /* A real session above 1 Wh followed by a sustained low-current tail arms full-off. */
    cfg.ports[0].full_mode=AUTO_ONCE;
    auto_engine_init(&e,&cfg);
    for (unsigned t=1;t<=500;t++) auto_engine_feed(&e,0,t,true,5,2,true,true,true);
    assert(e.ports[0].charging && e.ports[0].session_wh>=1.0f);
    for (unsigned t=501;t<=1500;t++) auto_engine_feed(&e,0,t,true,5,0.1f,true,true,true);
    assert(e.ports[0].pending && e.ports[0].reason==2);
    assert(auto_engine_take_off(&e,0,1500));
    assert(auto_engine_result(&e,0,1501,true));
    assert(e.config.ports[0].full_mode==AUTO_DISABLED);
    /* Permanent mode excludes automated off. */
    cfg.ports[0].full_mode=AUTO_DISABLED; cfg.ports[0].permanent=true;
    auto_engine_init(&e,&cfg);
    for (unsigned t=1;t<=1000;t++) auto_engine_feed(&e,0,t,true,5,0,true,true,true);
    assert(!e.ports[0].pending);
    /* Restored limit cannot silently resume from zero; unrelated mode changes do not rearm. */
    AutoRule old={.limit_wh=10,.limit_mode=AUTO_ONCE}, next=old;
    assert(auto_restart_paused(&old,&next,true));
    next.permanent=true; assert(auto_restart_paused(&old,&next,true));
    next=old; next.limit_wh=11; assert(!auto_restart_paused(&old,&next,true));
    next=old; next.limit_wh=0; assert(!auto_restart_paused(&old,&next,true));
    assert(!auto_restart_paused(&old,&old,false));
    puts("automation engine tests passed");
}
