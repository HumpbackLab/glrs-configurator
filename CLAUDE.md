# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Gyro ELRS Configurator — a Tauri v2 desktop/mobile app for configuring ExpressLRS basic flight-control receivers (ESP32-C3 RX targets with `HAS_BASIC_FLIGHT_CONTROL`). Targets Windows, Linux, and Android.

The app communicates with ELRS devices via HTTP (configuration read/write) and MSP v2 over TCP (read-only debug telemetry polling on port 5761).

## Build & Run

```bash
cd app
npm install
npm run dev          # Vite dev server on localhost:5200 (with ELRS HTTP proxy)
npm run build        # Production frontend build into app/dist/
npm run tauri dev    # Tauri dev shell (runs Vite + Rust backend)
npm run tauri build  # Tauri production build
```

The Vite config (`app/vite.config.js`) includes a custom proxy plugin at `/__elrs_proxy__/` that forwards requests to the device IP specified via `?target=` query param or `x-elrs-target` header. This avoids CORS issues when running the web UI standalone in a browser.

## Architecture

```
app/
  index.html              # Single-page entry point, mounts <div id="app">
  vite.config.js          # Vite + ELRS HTTP proxy middleware
  src/
    main.js               # Entire frontend application (~1870 lines)
    styles.css            # All styles (~670 lines)
  public/
    models/               # GLTF 3D models (aircraft for debug view)
  src-tauri/
    src/
      main.rs             # Tauri entry point
      lib.rs              # Rust backend: MSP v2 TCP client, Tauri commands
    Cargo.toml            # Dependencies: tauri 2, serde, serde_json
    tauri.conf.json       # Window config, CSP, bundle settings
```

**Frontend** (`app/src/main.js`): Vanilla JavaScript SPA with no framework. A single `state` object drives everything. The `render()` function replaces `#app` innerHTML entirely on every state change. Tab-based navigation with 9 panels: Status, Runtime, Model, PWM, Flight, Debug, Hardware JSON, WiFi, Update.

- **HTTP client**: `apiFetch()` and `xhrRequest()` wrap the device HTTP API. In browser dev mode, requests route through the Vite proxy. In Tauri, due to CSP `connect-src 'self' http://* https://*`, requests go direct.
- **State flow**: User action → mutate `state` → `render()` → `wireEvents()` rebinds listeners. Long operations wrap in `runBusy()` which sets `state.busy` and re-renders.
- **Flight control**: Euler angle controls (roll/pitch/yaw sliders) update a CSS 3D board preview and a 3×3 orientation matrix. The matrix is transposed on save (`orientationMatrixFromInstallEuler`) because the firmware stores the inverse transform.
- **PWM**: Each output pin encodes as a 32-bit config word with bitfields for mode, input channel, inversion, failsafe position, etc. See `decodePwmConfig()` / `encodePwmConfig()`.
- **MD5**: Inline implementation used to derive 6-byte UID from binding phrase.
- **Debug polling**: Calls Tauri Rust commands via `@tauri-apps/api/core` (`invoke()`). The Rust backend handles MSP v2 framing and TCP socket management.

**Backend** (`app/src-tauri/src/lib.rs`): Three `#[tauri::command]` functions — `msp_debug_connect`, `msp_debug_disconnect`, `msp_debug_poll`. The poll command sends an MSP v2 request (`MSP_ELRS_FC_DEBUG`, function `0x0450`), parses the 10-byte payload into `FcDebugSample` (roll/pitch/yaw/accel_roll/accel_pitch in centidegrees → degrees). CRC8-DVB-S2 checksum validation. TCP timeout is 500ms.

**3D rendering**: Three.js via `three` npm package. `initDebugAircraftView()` sets up a WebGL renderer with a fallback procedural aircraft model plus GLTF loading (`/models/model_rudderless_plane.gltf`). Aircraft attitude is updated from MSP debug samples.

## Device HTTP API

The ELRS receiver exposes these endpoints (all JSON unless noted):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/target` | Device info (target name, version, gyro presence, VBAT) |
| GET | `/config` | Full config with options metadata |
| POST | `/config` | Save config (omit `pwm` key when saving from non-PWM tabs) |
| GET | `/status.json` | Runtime status (main loop, PWM ISR, PWM crash stats, IMU) |
| GET/POST | `/channels` | RC channel values for WiFi-mode simulation |
| GET/POST | `/options.json` | Runtime options (WiFi interval, UART baud, lock-on-first-connection) |
| GET/POST | `/hardware.json` | Hardware definition JSON |
| POST | `/reboot` | Reboot device |
| POST | `/reset` | Reset model or hardware settings |
| POST | `/update` | Firmware upload (multipart form, XHR with progress) |
| GET | `/networks.json` | WiFi scan results |
| POST | `/sethome` | Save home WiFi credentials |

## Key Conventions

- The PWM `config` field is a single 32-bit integer, not a JSON object. Always use `encodePwmConfig()` / `decodePwmConfig()`.
- When saving flight config (`saveFlight`), delete `pwm` from the payload before POSTing to avoid overwriting PWM outputs.
- The orientation matrix stored in firmware (`fc_orientation`) is the inverse of the physical install angles shown in the UI. `orientationMatrixFromInstallEuler()` transposes the matrix on save.
- In dev mode (`localhost`), HTTP requests proxy through Vite middleware using the `target` query param. In Tauri, requests go direct to `state.apiBase`.
- The `state.extraMixerRows` counter tracks user-added motor rows beyond the firmware-reported mixer count.
- Binding phrase → UID derivation uses MD5 of `-DMY_BINDING_PHRASE="<phrase>"`.
