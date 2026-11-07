#pragma once
#include "config_store.h"
#include "cloud_protocol.h"
typedef bool (*cloud_snapshot_cb)(CloudSnapshot *snapshot);
/* Copies boot configuration; changes apply after the configuration reboot. */
typedef bool (*cloud_command_cb)(const CloudCommand *command);
typedef bool (*cloud_settings_cb)(char *out, size_t capacity);
void cloud_bridge_start(const DeviceConfig *cfg, cloud_snapshot_cb snapshot,
                        cloud_command_cb command, cloud_settings_cb settings, cloud_settings_cb automation);
/* Nonblocking completion handoff; called only after the actual BLE result. */
void cloud_bridge_complete(const char *id, bool ok, const char *error);
