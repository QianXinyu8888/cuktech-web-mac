#include "miot_protocol.h"
#include <string.h>

size_t miot_command_frame(uint8_t *frame, size_t capacity, const uint8_t *encrypted, size_t length) {
    if (capacity < 2 || length > capacity - 2) return 0;
    frame[0] = 1;
    frame[1] = 0;
    memcpy(frame + 2, encrypted, length);
    return length + 2;
}

bool miot_response_value(const uint8_t *response, size_t length, uint32_t *value) {
    if (length < 14) return false;
    uint8_t bytes = response[11];
    if ((bytes != 1 && bytes != 2 && bytes != 4) || length < 13U + bytes) return false;
    uint32_t decoded = 0;
    for (unsigned i = 0; i < bytes; ++i) decoded |= (uint32_t)response[13 + i] << (8 * i);
    *value = decoded;
    return true;
}

bool miot_get_response_value(uint8_t seq, uint8_t piid, const uint8_t *response, size_t length, uint32_t *value) {
    return length >= 14 && response[2] == seq && response[4] == 0x03 &&
        response[6] == SIID_CHARGER && response[7] == piid &&
        response[9] == 0 && response[10] == 0 && miot_response_value(response, length, value);
}

bool miot_set_ack_matches(uint8_t seq, uint8_t piid, const uint8_t *response, size_t length) {
    return response && length >= 8 && response[2] == seq && response[4] == 0x01 &&
        response[6] == SIID_CHARGER && response[7] == piid;
}
