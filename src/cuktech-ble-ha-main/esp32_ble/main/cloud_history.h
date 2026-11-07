#pragma once
#include "cloud_protocol.h"
#define CLOUD_HISTORY_CAPACITY 300
#define CLOUD_HISTORY_BATCH_MAX 60
typedef struct { float voltage, current, power; uint8_t flags, protocol; } CloudHistoryPort;
typedef struct { uint32_t timestamp; CloudHistoryPort ports[4]; } CloudHistorySample;
typedef struct {
    CloudHistorySample samples[CLOUD_HISTORY_CAPACITY];
    size_t head, count;
    uint32_t dropped;
} CloudHistoryQueue;
bool cloud_history_pack(const CloudSnapshot *snapshot, uint32_t timestamp, CloudHistorySample *sample);
bool cloud_history_push(CloudHistoryQueue *queue, const CloudHistorySample *sample);
bool cloud_history_peek(const CloudHistoryQueue *queue, size_t offset, CloudHistorySample *sample);
bool cloud_history_discard(CloudHistoryQueue *queue, size_t count);
bool cloud_history_format_sample(const CloudHistorySample *sample, char *out, size_t capacity);
bool cloud_parse_history_ack(const char *json, size_t length, char id[37]);
typedef struct { char id[37]; size_t count; } CloudHistoryFlight;
bool cloud_history_begin_batch(const CloudHistoryQueue *queue, CloudHistoryFlight *flight, const char *id);
bool cloud_history_ack_batch(CloudHistoryQueue *queue, CloudHistoryFlight *flight, const char *ack_id);
