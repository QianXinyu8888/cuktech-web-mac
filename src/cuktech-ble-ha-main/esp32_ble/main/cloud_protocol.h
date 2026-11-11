#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "automation_engine.h"
typedef struct { float voltage, current, power; bool active, valid, enabled_known, enabled; char protocol[16]; } CloudPort;
typedef struct { uint64_t uptime_ms; bool ble_connected; const char *ble_phase; CloudPort ports[4]; } CloudSnapshot;
typedef struct { char data[1024]; size_t length, total, frame_offset; bool accepting; } CloudRx;
bool cloud_url_valid(const char *url);
bool cloud_token_valid(const char *token);
bool cloud_update_token(char *dest, size_t capacity, const char *value);
int cloud_parse_rate(const char *json, size_t length);
bool cloud_rx_append(CloudRx *rx, const char *data, size_t length, size_t offset, size_t total);
bool cloud_format_telemetry(const CloudSnapshot *s, uint64_t seq, char *out, size_t capacity);

bool cloud_rx_frame(CloudRx *rx, int opcode, bool fin, const char *data, size_t length, size_t offset, size_t frame_length);

typedef enum { CLOUD_ACTION_PORT, CLOUD_ACTION_SET, CLOUD_ACTION_BLE, CLOUD_ACTION_AUTOMATION } CloudAction;
typedef struct {
    char id[37];
    CloudAction action;
    uint8_t piid; /* port bit 0..3 or 4(all), otherwise setting PIID */
    uint32_t value;
    AutoConfig automation;
    uint64_t expires_at;
} CloudCommand;
bool cloud_setting_valid(uint8_t piid, uint32_t value);
bool cloud_parse_command(const char *json, size_t length, uint64_t now_ms, CloudCommand *command);
/* Retain every processed ID through its validity window, including refusals. */
typedef struct { char id[37]; uint64_t expires_at; } CloudSeen;
typedef struct { CloudSeen seen[64]; } CloudCommandGate;
/* 1=new and recorded, 0=duplicate, -1=window capacity exhausted */
int cloud_command_record(CloudCommandGate *gate, const CloudCommand *command, uint64_t now_ms);
bool cloud_set_response_matches(uint8_t seq, uint8_t piid, const uint8_t *response, size_t length);
typedef struct {
    uint32_t values[32]; bool valid[32]; uint32_t protocol_extend;
    const char *device_model, *firmware_version;
} CloudSettings;
bool cloud_format_settings(const CloudSettings *settings, char *out, size_t capacity);

bool cloud_format_automation(const AutoEngine *engine, char *out, size_t capacity);

/* Masked single-port control requires an actual confirmed current mask. */
bool cloud_port_mask(uint8_t port, bool enabled, bool known, uint32_t current, uint32_t *result);
bool cloud_sample_new(uint32_t sequence, uint32_t previous, uint32_t sample_time, uint32_t now);
