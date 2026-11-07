#include "http_server.h"
#include "config.h"
#include "cloud_protocol.h"
#include "http_guard.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_coexist.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "cJSON.h"
#include "embedded_files.h"
#include "ble_manager.h"
#include <string.h>

static const char *TAG = "HTTP_SERVER";
static httpd_handle_t _server = NULL;
static DeviceConfig *_cfg = NULL;
static http_config_cb _on_save = NULL;
static port_data_cb _port_data_cb = NULL;
static settings_cb _settings_cb = NULL;
static port_control_cb _port_ctl_cb = NULL;
static setting_set_cb _setting_set_cb = NULL;
static protocol_toggle_cb _proto_toggle_cb = NULL;
static ble_control_cb _ble_ctl_cb = NULL;

void http_server_set_callbacks(port_data_cb ports, settings_cb settings,
                               port_control_cb port_ctl, setting_set_cb setting_set,
                               protocol_toggle_cb proto_toggle,
                               ble_control_cb ble_ctl) {
    _port_data_cb = ports;
    _settings_cb = settings;
    _port_ctl_cb = port_ctl;
    _setting_set_cb = setting_set;
    _proto_toggle_cb = proto_toggle;
    _ble_ctl_cb = ble_ctl;
}

static bool _api_guard(httpd_req_t *req, bool post) {
    char host[64]={0},origin[96]={0},site[32]={0},type[96]={0},ip1[16]={0},ip2[16]={0};
    if(httpd_req_get_hdr_value_str(req,"Host",host,sizeof host)!=ESP_OK)return false;
    const char *headers[]={"Origin","Sec-Fetch-Site","Content-Type"};
    char *buffers[]={origin,site,type}; size_t sizes[]={sizeof origin,sizeof site,sizeof type};
    for(int i=0;i<3;i++) {
        size_t len=httpd_req_get_hdr_value_len(req,headers[i]);
        if(len>=sizes[i])return false;
        if(len && httpd_req_get_hdr_value_str(req,headers[i],buffers[i],sizes[i])!=ESP_OK)return false;
    }
    esp_netif_t *sta=esp_netif_get_handle_from_ifkey("WIFI_STA_DEF"), *ap=esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    esp_netif_ip_info_t info;
    if(sta && esp_netif_get_ip_info(sta,&info)==ESP_OK)snprintf(ip1,sizeof ip1,IPSTR,IP2STR(&info.ip));
    if(ap && esp_netif_get_ip_info(ap,&info)==ESP_OK)snprintf(ip2,sizeof ip2,IPSTR,IP2STR(&info.ip));
    return http_guard_request(host,origin,site,type,post,ip1,ip2);
}
#define GUARD_API(req, post) do { if (!_api_guard(req,post)) { httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"forbidden"); return 0; } } while(0)

/* ==================== Ping / Health Check ==================== */


/* cJSON uses its thread-safe standard heap allocator in all tasks.
 * Retain the diagnostics API for existing callers; no shared arena to reset. */
size_t http_server_pool_gc(void) { return 0; }

static int _get_ping_handler(httpd_req_t *req) {
    GUARD_API(req, false);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true,\"service\":\"cuktech_charger_esp32\"}");
    return 0;
}

/* Static buffer for cJSON_PrintPreallocated — avoids per-request malloc/free
   of the 512B-4KB JSON string. 3KB fits all API responses. */
static char _json_buf[2048];

/* ==================== Status API (for HA integration validation) ==================== */

static int _get_status_handler(httpd_req_t *req) {
    GUARD_API(req, false);
    bool ready = ble_manager_is_ready();
    char buf[384];
    int n = snprintf(buf, sizeof(buf),
        "{\"ok\":true,\"connected\":%s,\"authenticated\":%s,"
        "\"ble_enabled\":%s,\"ble_ready\":%s,\"free_heap\":%u,"
        "\"min_free_heap\":%u,\"max_block\":%u,"
        "\"device_model\":\"%s\",\"firmware_version\":\"%s\"}",
        ready ? "true" : "false", ready ? "true" : "false",
        ble_manager_is_enabled() ? "true" : "false",
        ready ? "true" : "false", (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_minimum_free_heap_size(),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
        DEVICE_MODEL, FW_VERSION);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, buf, n);
    return 0;
}

/* ==================== Config API (with data masking) ==================== */

static int _get_config_handler(httpd_req_t *req) {
    GUARD_API(req, false);
    cJSON *root = cJSON_CreateObject();
    if (!root) return ESP_ERR_NO_MEM;
#define CONFIG_STR(field) cJSON_AddStringToObject(root, #field, _cfg->field)
#define CONFIG_SECRET(field) cJSON_AddStringToObject(root, #field, _cfg->field[0] ? "****" : "")
    CONFIG_STR(wifi_ssid); CONFIG_SECRET(wifi_pass);
    CONFIG_STR(device_mac); CONFIG_SECRET(device_token); CONFIG_SECRET(device_ble_key);
    CONFIG_STR(mqtt_broker); CONFIG_STR(mqtt_user); CONFIG_SECRET(mqtt_pass); CONFIG_STR(mqtt_topic_prefix);
    cJSON_AddNumberToObject(root, "mqtt_port", _cfg->mqtt_port);
    cJSON_AddBoolToObject(root, "mqtt_enable", _cfg->mqtt_enable);
    CONFIG_STR(cloud_url); CONFIG_SECRET(cloud_token);
    cJSON_AddBoolToObject(root, "cloud_enabled", _cfg->cloud_enabled);
    cJSON_AddBoolToObject(root, "bemfa_enable", _cfg->bemfa_enable);
    CONFIG_SECRET(bemfa_uid); CONFIG_STR(bemfa_name_c1); CONFIG_STR(bemfa_name_c2);
    CONFIG_STR(bemfa_name_c3); CONFIG_STR(bemfa_name_a); CONFIG_STR(bemfa_name_ble);
    cJSON_AddNumberToObject(root, "reboot_interval_sec", _cfg->reboot_interval_sec);
#undef CONFIG_STR
#undef CONFIG_SECRET
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(root, _json_buf, sizeof(_json_buf), false)) httpd_resp_sendstr(req, _json_buf);
    else httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "buffer_full");
    cJSON_Delete(root);
    return 0;
}


/* Helper: send JSON error instead of 500 (which causes browser retries) */
static void _json_error(httpd_req_t *req, const char *msg) {
    httpd_resp_set_type(req, "application/json");
    char buf[128]; snprintf(buf, sizeof(buf), "{\"ok\":false,\"error\":\"%s\"}", msg);
    httpd_resp_sendstr(req, buf);
}

static int _post_config_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[3072];
    if (req->content_len <= 0 || req->content_len >= sizeof(buf)) { _json_error(req, "body_too_large"); return 0; }
    int len = 0;
    while (len < req->content_len) {
        int got = httpd_req_recv(req, buf + len, req->content_len - len);
        if (got <= 0) { _json_error(req, "incomplete_body"); return 0; }
        len += got;
    }
    if (len <= 0) { _json_error(req, "empty"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }

    cJSON *cu = cJSON_GetObjectItemCaseSensitive(root, "cloud_url");
    cJSON *ct = cJSON_GetObjectItemCaseSensitive(root, "cloud_token");
    cJSON *ce = cJSON_GetObjectItemCaseSensitive(root, "cloud_enabled");
    const char *url = cu && cJSON_IsString(cu) ? cu->valuestring : _cfg->cloud_url;
    char token[sizeof(_cfg->cloud_token)];
    memcpy(token, _cfg->cloud_token, sizeof(token));
    if ((cu && !http_guard_cloud_change(_cfg->cloud_url,url,_cfg->cloud_token,ct && cJSON_IsString(ct)?ct->valuestring:NULL)) ||
        (cu && (!cJSON_IsString(cu) || strlen(url) >= sizeof(_cfg->cloud_url) || (*url && !cloud_url_valid(url)))) ||
        (ct && (!cJSON_IsString(ct) || !cloud_update_token(token, sizeof(token), ct->valuestring))) ||
        (ce && !cJSON_IsBool(ce)) ||
        ((ce ? cJSON_IsTrue(ce) : _cfg->cloud_enabled) && (!cloud_url_valid(url) || !cloud_token_valid(token)))) {
        cJSON_Delete(root); _json_error(req, "invalid_cloud_config"); return 0;
    }
    if (cu) strcpy(_cfg->cloud_url, url);
    memcpy(_cfg->cloud_token, token, sizeof(token));
    if (ce) _cfg->cloud_enabled = cJSON_IsTrue(ce);

    /* Sensitive fields: if the submitted value contains "****", skip
       overwriting (keep the original stored value). This matches the
       Python ble_server behaviour where the frontend submits masked
       values unchanged. */
    #define SET_STR(f, k) do { cJSON *j = cJSON_GetObjectItem(root, k); \
        if (j && cJSON_IsString(j)) { strncpy(_cfg->f, cJSON_GetStringValue(j), sizeof(_cfg->f)-1); \
            _cfg->f[sizeof(_cfg->f)-1] = '\0'; } } while(0)
    #define SET_STR_MASKED(f, k) do { cJSON *j = cJSON_GetObjectItem(root, k); \
        if (j && cJSON_IsString(j)) { const char *_v = cJSON_GetStringValue(j); \
            if (!strstr(_v, "****")) { strncpy(_cfg->f, _v, sizeof(_cfg->f)-1); \
                _cfg->f[sizeof(_cfg->f)-1] = '\0'; } \
        } \
    } while(0)
    SET_STR(wifi_ssid, "wifi_ssid"); SET_STR_MASKED(wifi_pass, "wifi_pass");
    SET_STR(device_mac, "device_mac"); SET_STR_MASKED(device_token, "device_token");
    SET_STR_MASKED(device_ble_key, "device_ble_key"); SET_STR(mqtt_broker, "mqtt_broker");
    SET_STR_MASKED(mqtt_user, "mqtt_user"); SET_STR_MASKED(mqtt_pass, "mqtt_pass");
    SET_STR(mqtt_topic_prefix, "mqtt_topic_prefix");
    /* Save old bemfa names before SET_STR overwrites them */
    char old_names[5][32];
    strncpy(old_names[0], _cfg->bemfa_name_c1, sizeof(old_names[0]) - 1);
    strncpy(old_names[1], _cfg->bemfa_name_c2, sizeof(old_names[1]) - 1);
    strncpy(old_names[2], _cfg->bemfa_name_c3, sizeof(old_names[2]) - 1);
    strncpy(old_names[3], _cfg->bemfa_name_a,  sizeof(old_names[3]) - 1);
    strncpy(old_names[4], _cfg->bemfa_name_ble, sizeof(old_names[4]) - 1);
    for (int i = 0; i < 5; i++) old_names[i][31] = '\0';

    SET_STR_MASKED(bemfa_uid, "bemfa_uid");
    SET_STR(bemfa_name_c1, "bemfa_name_c1");
    SET_STR(bemfa_name_c2, "bemfa_name_c2");
    SET_STR(bemfa_name_c3, "bemfa_name_c3");
    SET_STR(bemfa_name_a,  "bemfa_name_a");
    SET_STR(bemfa_name_ble, "bemfa_name_ble");

    /* Detect name changes → set modified flag for topic re-registration on next boot */
    {
        const char *n[5] = {_cfg->bemfa_name_c1, _cfg->bemfa_name_c2,
                            _cfg->bemfa_name_c3, _cfg->bemfa_name_a,
                            _cfg->bemfa_name_ble};
        for (int i = 0; i < 5; i++) {
            if (strcmp(old_names[i], n[i]) != 0) {
                _cfg->bemfa_modified = true;
                ESP_LOGI(TAG, "Bemfa name %d changed: \"%s\" -> \"%s\"",
                         i, old_names[i], n[i]);
                break;
            }
        }
    }

    cJSON *je = cJSON_GetObjectItem(root, "mqtt_enable");
    if (je && cJSON_IsBool(je)) _cfg->mqtt_enable = cJSON_IsTrue(je);
    cJSON *jb = cJSON_GetObjectItem(root, "bemfa_enable");
    if (jb && cJSON_IsBool(jb)) _cfg->bemfa_enable = cJSON_IsTrue(jb);
    cJSON *jp = cJSON_GetObjectItem(root, "mqtt_port");
    if (jp && cJSON_IsNumber(jp)) _cfg->mqtt_port = (uint16_t)cJSON_GetNumberValue(jp);
    cJSON *jrb = cJSON_GetObjectItem(root, "reboot_interval_sec");
    if (jrb && cJSON_IsNumber(jrb)) {
        double rb = cJSON_GetNumberValue(jrb);
        _cfg->reboot_interval_sec = (rb > 0) ? (uint32_t)rb : 0;
    }
    _cfg->valid = (_cfg->wifi_ssid[0] != '\0' && _cfg->wifi_pass[0] != '\0');

    ESP_LOGI(TAG, "Config saved: wifi=%s mqtt=%s:%d", _cfg->wifi_ssid, _cfg->mqtt_broker, _cfg->mqtt_port);
    config_store_save(_cfg);
    cJSON_Delete(root);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", true);
    cJSON_AddStringToObject(resp, "message", "Config saved. Rebooting...");
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);

    if (_on_save) _on_save();
    return 0;
}

/* ==================== Dashboard API ==================== */

static int _get_ports_handler(httpd_req_t *req) {
    GUARD_API(req, false);

    if (!_port_data_cb) { _json_error(req, "error"); return 0; }
    cJSON *root = _port_data_cb();
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(root, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(root);
    return 0;
}

static int _get_settings_handler(httpd_req_t *req) {
    GUARD_API(req, false);

    if (!_settings_cb) { _json_error(req, "error"); return 0; }
    cJSON *root = _settings_cb();
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(root, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(root);
    return 0;
}

/* Combined endpoint: returns status + ports + settings in one request.
   Replaces 3 separate fetches in the frontend, reducing TCP buffer pressure. */
static int _get_all_handler(httpd_req_t *req) {
    GUARD_API(req, false);

    bool ready = ble_manager_is_ready();
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "ok", true);
    cJSON_AddBoolToObject(root, "connected", ready);
    cJSON_AddBoolToObject(root, "authenticated", ready);
    cJSON_AddBoolToObject(root, "ble_enabled", ble_manager_is_enabled());
    cJSON_AddBoolToObject(root, "ble_ready", ready);
    cJSON_AddNumberToObject(root, "free_heap", esp_get_free_heap_size());
    cJSON_AddNumberToObject(root, "min_free_heap", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(root, "max_block", heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    cJSON_AddStringToObject(root, "device_model", DEVICE_MODEL);
    cJSON_AddStringToObject(root, "firmware_version", FW_VERSION);

    if (_port_data_cb) {
        cJSON *ports = _port_data_cb();
        if (ports) cJSON_AddItemToObject(root, "ports", ports);
    }
    if (_settings_cb) {
        cJSON *settings = _settings_cb();
        if (settings) cJSON_AddItemToObject(root, "settings", settings);
    }

    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(root, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(root);
    return 0;
}

static int _post_port_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[256];
    int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (len <= 0) { _json_error(req, "error"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }

    cJSON *jp = cJSON_GetObjectItem(root, "port");
    cJSON *ja = cJSON_GetObjectItem(root, "action");
    bool ok = false;
    if (jp && ja && cJSON_IsString(jp) && cJSON_IsString(ja) && _port_ctl_cb) {
        ok = _port_ctl_cb(cJSON_GetStringValue(jp), cJSON_GetStringValue(ja));
    }
    cJSON_Delete(root);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", ok);
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

static int _post_setting_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[256];
    int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (len <= 0) { _json_error(req, "error"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }

    cJSON *jp = cJSON_GetObjectItem(root, "piid");
    cJSON *jv = cJSON_GetObjectItem(root, "value");
    bool ok = false;
    if (jp && jv && cJSON_IsNumber(jp) && cJSON_IsNumber(jv) && _setting_set_cb) {
        ok = _setting_set_cb((int)cJSON_GetNumberValue(jp), (int)cJSON_GetNumberValue(jv));
    }
    cJSON_Delete(root);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", ok);
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

/* ==================== BLE Control API ==================== */

static int _post_ble_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[128];
    int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (len <= 0) { _json_error(req, "error"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }
    cJSON *je = cJSON_GetObjectItem(root, "enabled");
    bool ok = false;
    if (je && cJSON_IsBool(je) && _ble_ctl_cb) {
        ok = _ble_ctl_cb(cJSON_IsTrue(je));
    }
    cJSON_Delete(root);
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", ok);
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

/* ==================== Protocol Toggle API ==================== */

static int _post_protocol_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[256];
    int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (len <= 0) { _json_error(req, "error"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }
    cJSON *jp = cJSON_GetObjectItem(root, "port");
    cJSON *jproto = cJSON_GetObjectItem(root, "protocol");
    cJSON *ja = cJSON_GetObjectItem(root, "action");
    bool ok = false;
    if (jp && jproto && ja && cJSON_IsString(jp) && cJSON_IsString(jproto) && cJSON_IsString(ja) && _proto_toggle_cb) {
        ok = _proto_toggle_cb(cJSON_GetStringValue(jp), cJSON_GetStringValue(jproto),
                              strcmp(cJSON_GetStringValue(ja), "on") == 0);
    }
    cJSON_Delete(root);
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", ok);
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

/* ==================== Sleep API ==================== */

// PIID 6 息屏时间: 数组下标即原始值(1-5)，与米家插件一致。index 0 是占位，非有效设备值。
static const char *SCR_LABELS[] = {"", "5分钟", "10分钟", "30分钟", "常亮", "1分钟"};
#define SCR_COUNT 6
#define SCR_VALID(v) ((v) >= 1 && (v) < SCR_COUNT)

static int _get_sleep_handler(httpd_req_t *req) {
    GUARD_API(req, false);

    if (!_settings_cb) { _json_error(req, "error"); return 0; }
    cJSON *root = _settings_cb();
    int val = 0;
    cJSON *j6 = cJSON_GetObjectItem(root, "6");
    if (j6 && cJSON_IsNumber(j6)) val = (int)cJSON_GetNumberValue(j6);
    cJSON_Delete(root);
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddNumberToObject(resp, "value", val);
    cJSON_AddStringToObject(resp, "label", SCR_VALID(val) ? SCR_LABELS[val] : "?");
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

static int _post_sleep_handler(httpd_req_t *req) {
    GUARD_API(req, true);

    char buf[128];
    int len = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (len <= 0) { _json_error(req, "error"); return 0; }
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) { _json_error(req, "bad_json"); return 0; }
    cJSON *jv = cJSON_GetObjectItem(root, "value");
    bool ok = false;
    if (jv && cJSON_IsNumber(jv) && _setting_set_cb) {
        int val = (int)cJSON_GetNumberValue(jv);
        if (SCR_VALID(val)) ok = _setting_set_cb(6, val);
    }
    cJSON_Delete(root);
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", ok);
    httpd_resp_set_type(req, "application/json");
    if (cJSON_PrintPreallocated(resp, _json_buf, sizeof(_json_buf), false))
        httpd_resp_sendstr(req, _json_buf);
    else
        httpd_resp_sendstr(req, "{\"error\":\"buffer_full\"}");
    cJSON_Delete(resp);
    return 0;
}

/* ==================== Embedded static file serving ==================== */

static const EmbeddedFile *_find_embedded(const char *path) {
    for (const EmbeddedFile *f = embedded_files; f->path; f++) {
        if (strcmp(f->path, path) == 0) return f;
    }
    return NULL;
}

/* Send embedded file via chunked transfer. Temporarily switches WiFi/BLE
   coexistence to WiFi-priority so large files don't time out when BLE is
   actively exchanging data. Restores balance mode when done. */
static void _serve_embedded(httpd_req_t *req, const EmbeddedFile *f) {
    /* Boost WiFi priority during file transfer to prevent TCP timeouts
       caused by BLE radio contention on the single 2.4 GHz antenna.
       Restored to BALANCE before returning. */
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);

    httpd_resp_set_type(req, f->content_type);
    if (f->encoding) {
        httpd_resp_set_hdr(req, "Content-Encoding", f->encoding);
    }
    httpd_resp_set_hdr(req, "Cache-Control", "max-age=604800");
    const uint8_t *p = f->data;
    size_t left = f->size;
    const size_t CHUNK = 4096;
    while (left > 0) {
        size_t n = (left > CHUNK) ? CHUNK : left;
        esp_err_t err;
        int retries = 8;
        int delay_ms = 5;
        do {
            err = httpd_resp_send_chunk(req, (const char *)p, n);
            if (err == ESP_ERR_HTTPD_RESP_SEND) {
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                delay_ms *= 2;
            }
        } while (err == ESP_ERR_HTTPD_RESP_SEND && --retries > 0);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Send chunk FAILED for %s (%d bytes remaining)", f->path, (int)left);
            httpd_resp_send_chunk(req, NULL, 0);
            esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
            return;
        }
        p += n;
        left -= n;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    httpd_resp_send_chunk(req, NULL, 0);
    esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
    ESP_LOGI(TAG, "Served: %s (%d bytes)", f->path, (int)f->size);
}

/* ==================== Dashboard / Config page ==================== */

/* All page/static handlers: always return 0 (never -1) so HTTP server
   doesn't send 500. If send fails, the connection is already dead. */
static int _get_dash_handler(httpd_req_t *req) {
    // 判断当前模式: AP 配网中(无 STA IP) → config.html, 正常运行(有 STA IP) → phone.html
    bool is_config = true;
    if (_cfg && _cfg->valid) {
        esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (sta) {
            esp_netif_ip_info_t ip;
            if (esp_netif_get_ip_info(sta, &ip) == ESP_OK && ip.ip.addr != 0)
                is_config = false;
        }
    }
    const char *target = is_config ? "/config.html" : "/phone.html";
    const EmbeddedFile *f = _find_embedded(target);
    if (f) { _serve_embedded(req, f); return 0; }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"embedded_file_not_found\"}");
    return 0;
}

static int _get_config_page_handler(httpd_req_t *req) {
    const EmbeddedFile *f = _find_embedded("/config.html");
    if (f) { _serve_embedded(req, f); return 0; }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"embedded_file_not_found\"}");
    return 0;
}

static int _get_static_handler(httpd_req_t *req) {
    const char *path = req->uri;
    if (strcmp(path, "/") == 0 || strcmp(path, "/dashboard") == 0)
        path = "/phone.html";

    const EmbeddedFile *f = _find_embedded(path);
    if (f) { _serve_embedded(req, f); return 0; }
    /* Fallback: phone.html for unknown routes */
    if (strcmp(path, "/phone.html") != 0) {
        f = _find_embedded("/phone.html");
        if (f) { _serve_embedded(req, f); return 0; }
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"not_found\"}");
    return 0;
}

/* ==================== Server Start ==================== */

void http_server_start(DeviceConfig *cfg, http_config_cb on_save) {
    _cfg = cfg;
    _on_save = on_save;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 80;
    config.max_open_sockets = 8;
    config.server_port = 80;
    config.max_resp_headers = 1024;  /* 4KB was overkill — 1KB covers all JSON responses */
    config.stack_size = 6144;
    config.send_wait_timeout = 10;  /* seconds; default 5, increase for BLE coexistence */

    if (httpd_start(&_server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start HTTP server");
        return;
    }

    /* Register API endpoints */
    const httpd_uri_t uris[] = {
        { .uri = "/api/ping",     .method = HTTP_GET,  .handler = _get_ping_handler },
        { .uri = "/api/status",   .method = HTTP_GET,  .handler = _get_status_handler },
        { .uri = "/api/all",      .method = HTTP_GET,  .handler = _get_all_handler },
        { .uri = "/api/config",   .method = HTTP_GET,  .handler = _get_config_handler },
        { .uri = "/api/config",   .method = HTTP_POST, .handler = _post_config_handler },
        { .uri = "/api/ports",    .method = HTTP_GET,  .handler = _get_ports_handler },
        { .uri = "/api/settings", .method = HTTP_GET,  .handler = _get_settings_handler },
        { .uri = "/api/port",     .method = HTTP_POST, .handler = _post_port_handler },
        { .uri = "/api/setting",  .method = HTTP_POST, .handler = _post_setting_handler },
        { .uri = "/api/protocol", .method = HTTP_POST, .handler = _post_protocol_handler },
        { .uri = "/api/ble",      .method = HTTP_POST, .handler = _post_ble_handler },
        /* OTA endpoint removed to save space */
        { .uri = "/api/sleep",    .method = HTTP_GET,  .handler = _get_sleep_handler },
        { .uri = "/api/sleep",    .method = HTTP_POST, .handler = _post_sleep_handler },
        { .uri = "/",             .method = HTTP_GET,  .handler = _get_dash_handler },
        { .uri = "/dashboard",    .method = HTTP_GET,  .handler = _get_dash_handler },
        { .uri = "/config",       .method = HTTP_GET,  .handler = _get_config_page_handler },
    };
    for (int i = 0; i < sizeof(uris)/sizeof(uris[0]); i++) {
        esp_err_t err = httpd_register_uri_handler(_server, &uris[i]);
        if (err != ESP_OK) ESP_LOGW(TAG, "Failed to register %s: %s", uris[i].uri, esp_err_to_name(err));
    }

    /* Register each embedded file individually — exact URI matching only */
    httpd_uri_t static_uri = {.method = HTTP_GET, .handler = _get_static_handler};
    for (const EmbeddedFile *f = embedded_files; f->path; f++) {
        static_uri.uri = f->path;
        esp_err_t err = httpd_register_uri_handler(_server, &static_uri);
        if (err != ESP_OK) ESP_LOGE(TAG, "Register FAILED: %s (%s)", f->path, esp_err_to_name(err));
        else               ESP_LOGI(TAG, "Registered: %s → %s (%d bytes)", f->path, f->content_type, (int)f->size);
    }
    ESP_LOGI(TAG, "HTTP server started on port 80");
}

void http_server_stop(void) {
    if (_server) { httpd_stop(_server); _server = NULL; }
}
