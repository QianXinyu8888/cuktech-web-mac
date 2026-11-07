#pragma once
#include <stdbool.h>
#include <stdint.h>
#define AUTO_PORTS 4
#define AUTO_WINDOW 301
#define AUTO_NONE UINT32_MAX
typedef enum { AUTO_DISABLED=0, AUTO_ONCE=1, AUTO_ALWAYS=2 } AutoMode;
typedef struct { float limit_wh; uint8_t limit_mode, full_mode; bool permanent; } AutoRule;
typedef struct { AutoRule ports[AUTO_PORTS]; } AutoConfig;
typedef struct { uint32_t t; float power; } AutoPoint;
typedef struct {
    AutoPoint points[AUTO_WINDOW]; uint16_t head,count;
    float session_wh,last_power,peak,restart_w,grace;
    uint32_t last_time,session_start,above_since,hold_since,no_load_since,last_eval,retry_at;
    bool charging,post_session,pending,inflight,fired,from_session;
    uint8_t attempts,reason;
    char error[32];
} AutoPortState;
typedef struct { AutoConfig config; AutoPortState ports[4]; float scratch[AUTO_WINDOW]; } AutoEngine;
bool auto_config_valid(const AutoConfig *config);
void auto_engine_init(AutoEngine *engine, const AutoConfig *config);
void auto_engine_configure(AutoEngine *engine, const AutoConfig *config);
void auto_engine_feed(AutoEngine *engine, unsigned port, uint32_t t, bool valid, float voltage, float current, bool active, bool enabled_known, bool enabled);
bool auto_engine_take_off(AutoEngine *engine, unsigned port, uint32_t t);
/* true iff a successful actual SET16 result consumed a once setting. */
bool auto_engine_result(AutoEngine *engine, unsigned port, uint32_t t, bool success);

/* Restored limits remain paused until the limit itself is explicitly changed. */
bool auto_restart_paused(const AutoRule *previous,const AutoRule *next,bool paused);
void auto_engine_reset_port(AutoEngine *engine,unsigned port);
