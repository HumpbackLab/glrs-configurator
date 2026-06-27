# Phase 0 Baseline

## Scope

- Target hardware: ESP32-C3 RX targets exposing `HAS_BASIC_FLIGHT_CONTROL`.
- Primary app platforms: Linux desktop, Windows desktop, Android.
- Optional later platform: macOS.
- First-version configuration transport: existing HTTP API.
- First-version debug transport: MSP-over-WiFi TCP, read-only, deferred to Phase 4+.

## Connection Modes

- WiFi AP mode by direct device IP. Default quick-connect IP is `http://10.0.0.1`.
- WiFi STA mode by manual LAN IP.
- mDNS and discovery beacons are optional later work because Android behavior varies.

## Current HTTP API Inventory

- `GET /target`
- `GET /config`
- `POST /config`
- `GET /status.json`
- `GET /channels`
- `POST /channels`
- `GET /options.json`
- `POST /options.json`
- `GET /hardware.json`
- `POST /hardware.json`
- `POST /reboot`
- `POST /reset`

## Flight-Control Fields

- `fc_rate_pid`: 12 values, three axes by four PID columns.
- `fc_angle_pid`: 12 values, three axes by four PID columns.
- `fc_angle_enabled`: boolean.
- `fc_mixer`: rows of four values: throttle, roll, pitch, yaw.
- `fc_mixer_count`: firmware-reported mixer value count.
- `fc_orientation`: 9 values, row-major 3x3 matrix.
- PWM output `mixerMode`: encoded in bit 23 of each PWM config word.

## Android Requirements To Verify

- HTTP requests to direct IP while connected to an AP without internet.
- TCP sockets to the future MSP debug port.
- Foreground-only polling for the first release.
- Reconnect behavior after Android network switching or captive-portal prompts.
- Log/config export through Android share/save flows rather than fixed filesystem paths.

