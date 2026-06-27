# Gyro ELRS Configurator Task Breakdown

## Goal

Build a configurator for the ELRS basic flight-control feature, with Windows, Linux, and Android support.

The first version should keep existing configuration behavior working through the current HTTP API, then add MSP-over-WiFi TCP read-only debug polling for IMU, attitude, loop timing, and mixer/runtime status.

## Principles

- Keep device WebUI as a lightweight fallback for basic setup, recovery, WiFi, and OTA.
- Use Tauri as the primary configurator shell for desktop and Android if its mobile TCP/HTTP support is sufficient.
- Keep configuration writes on the existing HTTP API at first.
- Add MSP/TCP only for high-frequency read-only debug data in the first implementation.
- Prefer polling over active streaming for the first version.
- Avoid maintaining two independent configuration implementations.
- Treat Android as a first-class target, not a later UI port.

## Phase 0: Scope And Baseline

- Confirm target hardware scope: ESP32-C3 RX targets with `HAS_BASIC_FLIGHT_CONTROL`.
- Confirm supported connection modes:
  - WiFi AP mode by direct device IP.
  - WiFi STA mode by LAN IP or mDNS if available.
- Confirm supported app platforms:
  - Linux desktop.
  - Windows desktop.
  - Android as a required release target.
  - macOS optional later.
- Confirm Android networking constraints:
  - App can access device AP network without internet.
  - App can open TCP sockets to the device debug MSP port.
  - App can make HTTP requests to device IPs.
  - App handles Android network switching and captive portal prompts.
  - App keeps polling active only while foregrounded, unless explicit logging support is added.
- Inventory current HTTP APIs used by local WebUI:
  - `GET /config`
  - `POST /config`
  - `GET /status.json`
  - `GET /channels`
  - `POST /channels`
  - `GET /options.json`
  - `POST /options.json`
  - `POST /reboot`
  - `POST /reset`
- Inventory current flight-control fields:
  - `fc_rate_pid`
  - `fc_angle_pid`
  - `fc_angle_enabled`
  - `fc_mixer`
  - `fc_mixer_count`
  - `fc_orientation`
  - PWM output `mixerMode`

## Phase 1: Tauri Project Skeleton

- Create a Tauri app scaffold under `gyro-elrs-configurator/app`.
- Enable Tauri mobile project structure from the start, or document the blocker if current Tauri mobile support is insufficient for the required TCP path.
- Choose frontend stack:
  - Start with plain Vite plus vanilla JavaScript if reusing current local WebUI directly.
  - Move to React/Svelte only if state and UI complexity justify it.
- Add basic app shell:
  - Device connection screen.
  - Configuration view placeholder.
  - Debug/status view placeholder.
  - Settings/log directory placeholder.
- Design responsive layouts for:
  - Desktop wide screens.
  - Android phones in portrait orientation.
  - Android tablets or landscape orientation.
- Add Tauri permissions for:
  - HTTP requests to device IPs.
  - TCP socket access from Rust backend.
  - Local file writes for logs and exports.
- Add desktop platform handling:
  - Windows firewall prompt and connection troubleshooting.
  - Windows installer or portable package decision.
  - Linux AppImage or deb/rpm package decision.
  - Consistent log/config export paths on Windows and Linux.
- Add Android permissions and platform handling:
  - Internet/network access.
  - Local network access behavior if required by Android version.
  - Foreground-only polling behavior.
  - File export through Android share/save flows instead of assuming a desktop filesystem path.

## Phase 2: Port Existing Local WebUI Configuration

- Move current local WebUI configuration logic into reusable frontend modules:
  - API client.
  - Config state normalization.
  - PWM encode/decode helpers.
  - Flight-control PID/mixer/orientation helpers.
- Implement HTTP device client:
  - Fetch `/config`.
  - Fetch `/status.json`.
  - Save `/config`.
  - Save `/options.json`.
  - Reboot/reset actions.
- Port initial UI panels:
  - Runtime options.
  - Model/receiver options.
  - PWM outputs.
  - Flight-control PID/mixer/orientation.
  - Hardware JSON editor, if still needed.
- Add validation before save:
  - PID array lengths.
  - Mixer motor count and row length.
  - Orientation matrix length and numeric values.
  - PWM duplicate exclusive modes.

## Phase 3: Device Discovery And Connection Management

- Add manual connection by IP address.
- Add Android-friendly connection helpers:
  - Default quick-connect IP for device AP mode.
  - Clear AP/STA connection state.
  - Retry after Android WiFi network switch.
- Add connection status:
  - HTTP reachable.
  - Device target/name/version.
  - Config load success.
  - MSP/TCP debug port reachable.
- Add recent devices list.
- Optional later:
  - mDNS discovery.
  - UDP discovery beacon.
  - QR or pasted device URL import.
- On Android, treat mDNS as optional because platform behavior can be inconsistent across vendors and Android versions.

## Phase 4: MSP/TCP Debug Protocol Design

- Keep this read-only in first version.
- Use request/response polling, not active stream.
- Define ELRS private MSP command IDs.
- Suggested commands:
  - `MSP_ELRS_FC_DEBUG_SUMMARY`
  - `MSP_ELRS_FC_IMU`
  - `MSP_ELRS_FC_ATTITUDE`
  - `MSP_ELRS_FC_LOOP_PROFILE`
  - `MSP_ELRS_FC_MIXER_OUTPUT`
- Prefer one combined payload for graphing:
  - Timestamp in microseconds or milliseconds.
  - Gyro XYZ.
  - Accel XYZ.
  - Roll/pitch/yaw or attitude estimate.
  - Main loop average/max period.
  - Main loop average/max work time.
  - Flight-control ready flags.
  - Mixer output values.
- Include protocol version in the debug summary payload.
- Add explicit unsupported-command response behavior.

## Phase 5: Firmware MSP/TCP Read-Only Endpoint

- Decide whether to reuse current `TCPSOCKET` server or add a separate debug TCP endpoint.
- Avoid breaking existing MSP WiFi bridge behavior.
- Add an MSP request parser path for local ELRS debug commands.
- Implement snapshot collection:
  - Raw/latest gyro sample.
  - Raw/latest accel sample.
  - Current attitude.
  - Flight-control runtime readiness.
  - Mixer output.
  - Main loop profile.
- Ensure snapshot reads are non-blocking.
- Ensure TCP handling does not stall PWM, radio, or flight-control runtime.
- Add compile guards:
  - `TARGET_RX`
  - `USE_MSP_WIFI` or new debug-specific flag.
  - `HAS_BASIC_FLIGHT_CONTROL`

## Phase 6: Tauri Rust MSP Client

- Implement TCP connect/disconnect.
- Implement MSP v2 packet encode/decode.
- Implement request timeout and retry policy.
- Verify the same Rust networking code works on Android through Tauri mobile.
- If Tauri mobile cannot support the required TCP path cleanly, evaluate:
  - A small Android native plugin exposing TCP socket operations.
  - A Capacitor/Android-native fallback only for the transport layer.
  - Keeping the frontend shared while swapping the platform transport backend.
- Implement polling scheduler:
  - Default 20 Hz.
  - Allow 10 Hz, 20 Hz, 50 Hz.
  - Drop or skip polls if previous request has not completed.
  - Track RTT and error rate.
- Expose debug samples to frontend through Tauri events.
- Add local CSV/JSONL logging for debug samples.
- On Android, implement export/share for logs rather than assuming direct file browsing.

## Phase 7: Debug UI

- Add live status cards:
  - Device connection.
  - MSP RTT.
  - Poll rate.
  - FC ready state.
  - Sensor availability.
  - Loop timing.
- Add charts:
  - Gyro XYZ.
  - Accel XYZ.
  - Attitude roll/pitch/yaw.
  - Mixer output.
  - Loop period/work time.
- Add graph controls:
  - Poll rate selector.
  - Pause/resume.
  - Clear graph.
  - Select visible series.
  - Start/stop recording.
- Keep chart history bounded, for example 300-1000 samples.
- Add Android UI requirements:
  - Touch-friendly controls.
  - No hover-only interactions.
  - Charts readable on phone width.
  - Avoid heavy simultaneous graph rendering by default.
  - Provide a compact "live attitude" view for field use.

## Phase 8: Validation And Performance Testing

- Verify HTTP configuration parity with current local WebUI.
- Verify desktop behavior on:
  - Linux.
  - Windows.
- Verify MSP polling at:
  - 10 Hz.
  - 20 Hz.
  - 50 Hz.
- Measure impact on:
  - Main loop average/max period.
  - PWM ISR profile on ESP8266 only if still relevant.
  - WiFi reconnect behavior.
  - CPU and heap usage.
- Test disconnect cases:
  - TCP client disconnect.
  - WiFi AP/STA switch.
  - Device reboot.
  - Configurator app quit while connected.
- Test Android-specific cases:
  - App background/foreground.
  - Screen lock/unlock.
  - Android switches away from device AP because it has no internet.
  - Device AP reconnect after reboot.
  - Log export/share permission flow.
  - Battery impact at 20 Hz and 50 Hz polling.
- Confirm no queued debug data grows without bounds.

## Phase 9: Packaging

- Add build scripts for Linux and Windows desktop releases.
- Add Android build pipeline as a required deliverable.
- Add app version display.
- Add firmware compatibility warning if debug protocol version mismatches.
- Add release artifact naming:
  - `gyro-elrs-configurator-linux-x64`
  - `gyro-elrs-configurator-windows-x64`
  - `gyro-elrs-configurator-android-arm64.apk`
  - `gyro-elrs-configurator-android-arm64.aab` if Play Store style distribution is needed.
  - later macOS if needed.
- Document first-run connection steps.
- Document Windows and Linux install/connection steps:
  - Firewall/network permission notes.
  - Connecting to ELRS device AP.
  - Manual IP fallback.
  - Log/config export location.
- Document Android install and connection steps:
  - Sideload APK.
  - Connect phone to ELRS device AP.
  - Keep using device AP even if Android warns that it has no internet.
  - Enter device IP or use quick-connect.

## Suggested Milestones

### Milestone 1: Shared Config Parity

- Tauri app can connect by IP.
- Tauri app can load and save the same config fields as current local WebUI.
- No MSP/TCP yet.
- Layout works on desktop and Android viewport sizes.

### Milestone 2: MSP Debug Poll Prototype

- Firmware responds to one combined MSP debug command.
- Tauri Rust backend polls it at 20 Hz.
- Frontend displays raw numeric values.
- Confirm MSP/TCP polling works on Android, or record the required native transport fallback.

### Milestone 3: Live Debug Dashboard

- Charts for gyro, accel, attitude, mixer output, and loop timing.
- Poll rate selector.
- Pause and record support.
- Android compact debug view is usable in the field.

### Milestone 4: Hardened Tool

- Robust reconnect.
- Protocol version checks.
- Bounded buffers.
- Basic packaging.
- Linux, Windows, and Android release artifacts are produced.

## Open Questions

- Should MSP debug use the existing Betaflight-compatible TCP port `5761`, or a separate ELRS debug port?
- Should HTTP requests be made from the frontend directly or proxied through the Tauri Rust backend?
- Should debug samples include raw IMU before orientation, oriented IMU after `fc_orientation`, or both?
- What is the minimum acceptable debug rate: 20 Hz or 50 Hz?
- Do we need long recording, or only live graphing for first version?
- Is Tauri mobile mature enough for the required Android TCP socket and file export flows?
- Should Android support be APK sideload only, or should an AAB/Play Store distribution path be planned?
