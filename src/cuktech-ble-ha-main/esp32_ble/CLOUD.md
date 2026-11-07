# ESP32 cloud telemetry foundation

ESP-IDF **5.3.4**, target **esp32s3**, managed `espressif/esp_websocket_client` **1.6.0**.
`cloud_bridge` is a separate task. It copies the four-port telemetry whitelist under the app mutex, then performs JSON/network work outside the lock. Wi-Fi loss stops/destroys the socket; BLE loss is reported in `bleConnected`. Port `valid` distinguishes never measured from a measured zero. Remote commands use an exact port/setting/BLE whitelist, UUIDv4 IDs, a ten-second validity window, one in-flight command, and a dedup window. Queueing or ACK alone never reports control success: SET requires a matching sequence/service/PIID result, enable waits for READY, and disable waits for confirmed disconnect.

Configure through the first-boot access point and local setup assistant: enable Cloud, set `wss://HOST/api/device`, and set a separate upload token. The access point uses a fresh random password printed on the USB serial console at boot; keep that console private. Its password changes on reboot. These settings are saved in NVS, with no source defaults. Saving restarts the device. The local HTTP server is disabled after cloud mode is configured; changing its settings requires provisioning again. TLS validates both the hostname and the CA bundle; SNTP must establish a plausible UTC time before dialing. Rate messages allow only 1000 or 30000 ms and support both buffer chunking and WebSocket continuation frames.

The S3 profile targets N16R8's nominal 16 MB flash but leaves PSRAM disabled. Identify the physical flash and back it up before any flash operation. The 4 MB partition layout is deliberately retained and fits the image; larger partitions/OTA need a separate migration design. MQTT is available but disabled in default configuration.

## Verification

```sh
# On a normal complete ESP-IDF installation:
. "$HOME/esp/esp-idf-cuktech/export.sh"
python tools/generate_embedded.py
bash tests/run_host.sh
idf.py -DIDF_TARGET=esp32s3 build
```

`tests/run_host.sh` compiles protocol/config validation against the SDK's actual cJSON with strict warnings and UBSan. It covers WSS URL restrictions, token header-injection prevention, masked-token preservation, accepted/rejected rate messages, fragmented text, all four ports including `valid`, non-finite telemetry, and injected allocation failures.

Generated header, `sdkconfig`, managed component sources, and build output are ignored. The repository contains no cloud credentials. Hardware Wi-Fi/BLE/TLS/heap/reconnect endurance is still required; a successful build does not constitute charger acceptance.


## History buffering

A separate task samples state once per second after SNTP provides a valid epoch. BLE-disconnected ports are marked `valid:false`. A 60-sample `history_batch` has a UUIDv4 and UNIX-second timestamps; the cloud task streams it as one fragmented text message using continuation frames, so no large JSON allocation is needed. Sampling continues during TLS/reconnect/send waits.

The RAM FIFO holds **300 seconds (five minutes)**, including the oldest unacknowledged batch. Only a matching `history_ack` after the cloud transaction removes data. A lost ACK/disconnect resends the same ID and samples; the backend deduplicates timestamps and ACKs duplicates. When full, the FIFO preserves the oldest data and **drops new samples**, logging the total dropped count (first occurrence, then every 60 drops). This is a bounded RAM buffer: power loss/reboot loses buffered history, and outages beyond capacity lose newer samples. It provides no claim of unlimited offline retention. Each history send has a three-second overall attempt budget; incomplete text is discarded by reconnecting and retrying the retained batch.
