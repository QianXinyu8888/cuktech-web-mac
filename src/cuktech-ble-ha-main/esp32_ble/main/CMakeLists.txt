idf_component_register(
    SRCS "main.c" "ble_manager.c" "miot_auth.c" "miot_protocol.c" "config_store.c" "http_server.c" "bemfa.c" "cloud_bridge.c" "cloud_protocol.c" "cloud_history.c" "automation_engine.c" "automation_store.c" "http_guard.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_event nvs_flash esp_netif mqtt esp_timer bt esp_http_server esp_coex bootloader_support
    PRIV_REQUIRES json esp_http_client esp_websocket_client mbedtls lwip
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error)
