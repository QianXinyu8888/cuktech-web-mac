# Anonymous BLE protocol regression samples

`notify_frames.json` contains 142 upstream notification samples derived from real CUKTECH BLE traffic. These are **not synthetic**. They retain protocol packet bytes, decoded fields and relative timing to support parser and notification-dispatch regression tests.

Publication removes device identifiers, capture filenames, absolute and raw capture timestamps, record indices, recording-host details and other recording metadata. Only neutral sample groups (`sample1`, etc.) identify sequences. No token, BLE authentication key, derived session key or authentication handshake is included.

## Format and replay

- `hex`: notification value bytes including the four-byte CUKTECH frame header, followed by the encrypted envelope.
- `plaintext_hex`: decoded protocol bytes; stub decryption with these bytes for transport tests, or pass them to the production decoder for decode tests.
- `t_rel_ms`: timing relative to the start of an anonymous sample group; it is not a wall-clock timestamp.
- `frame_header`, `device_it`, `decoded`, `decoded_port`: protocol fields and expected decoder output.
- `kind`, `encrypted`, `notes`, `att_handle`: packet shape and decoding caveats.

These samples are all inline notifications; multiframe coverage uses synthetic tests. Four samples contain five-byte plaintexts and exercise the short-payload edge case. Actual AES-CCM replay requires private session material and is intentionally not supported by this public fixture.

The extraction script can analyze new captures locally. Its raw output must be anonymized and reviewed before publication; do not commit raw HCI captures or authentication material.
