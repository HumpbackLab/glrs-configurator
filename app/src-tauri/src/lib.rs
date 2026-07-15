use serde::Serialize;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const MSP_ELRS_FC_DEBUG: u16 = 0x0450;
const MSP_DEBUG_PORT: u16 = 5761;
const MSP_DEBUG_TIMEOUT_MS: u64 = 500;

struct MspDebugState {
    stream: Mutex<Option<TcpStream>>,
}

#[derive(Serialize)]
struct FcDebugSample {
    roll_deg: f32,
    pitch_deg: f32,
    yaw_deg: f32,
    accel_roll_deg: f32,
    accel_pitch_deg: f32,
}

fn crc8_dvb_s2(mut crc: u8, value: u8) -> u8 {
    crc ^= value;
    for _ in 0..8 {
        if crc & 0x80 != 0 {
            crc = (crc << 1) ^ 0xD5;
        } else {
            crc <<= 1;
        }
    }
    crc
}

fn msp_v2_request(function: u16) -> [u8; 9] {
    let mut frame = [0u8; 9];
    frame[0] = b'$';
    frame[1] = b'X';
    frame[2] = b'<';
    frame[3] = 0;
    frame[4] = (function & 0xFF) as u8;
    frame[5] = (function >> 8) as u8;
    frame[6] = 0;
    frame[7] = 0;
    let mut crc = 0;
    for byte in &frame[3..8] {
        crc = crc8_dvb_s2(crc, *byte);
    }
    frame[8] = crc;
    frame
}

fn read_u16(payload: &[u8], offset: &mut usize) -> Result<u16, String> {
    if *offset + 2 > payload.len() {
        return Err("short MSP debug payload".into());
    }
    let value = u16::from_le_bytes([payload[*offset], payload[*offset + 1]]);
    *offset += 2;
    Ok(value)
}

fn read_i16(payload: &[u8], offset: &mut usize) -> Result<i16, String> {
    Ok(read_u16(payload, offset)? as i16)
}

fn read_exact_timeout(stream: &mut TcpStream, buffer: &mut [u8]) -> Result<bool, String> {
    let mut offset = 0usize;
    while offset < buffer.len() {
        match stream.read(&mut buffer[offset..]) {
            Ok(0) => return Err("MSP debug socket closed".into()),
            Ok(size) => offset += size,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Ok(false);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(true)
}

fn parse_debug_payload(payload: &[u8]) -> Result<FcDebugSample, String> {
    let mut offset = 0usize;
    if payload.len() != 10 {
        return Err("short MSP debug payload".into());
    }
    let roll_cd = read_i16(payload, &mut offset)?;
    let pitch_cd = read_i16(payload, &mut offset)?;
    let yaw_cd = read_i16(payload, &mut offset)?;
    let accel_roll_cd = read_i16(payload, &mut offset)?;
    let accel_pitch_cd = read_i16(payload, &mut offset)?;

    Ok(FcDebugSample {
        roll_deg: roll_cd as f32 / 100.0,
        pitch_deg: pitch_cd as f32 / 100.0,
        yaw_deg: yaw_cd as f32 / 100.0,
        accel_roll_deg: accel_roll_cd as f32 / 100.0,
        accel_pitch_deg: accel_pitch_cd as f32 / 100.0,
    })
}

fn parse_host(api_base: &str) -> Result<String, String> {
    let without_scheme = api_base
        .trim()
        .strip_prefix("http://")
        .or_else(|| api_base.trim().strip_prefix("https://"))
        .unwrap_or(api_base.trim());
    let host = without_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .trim();
    if host.is_empty() {
        return Err("missing device host".into());
    }
    Ok(host.to_string())
}

#[tauri::command]
fn msp_debug_connect(api_base: String, state: tauri::State<MspDebugState>) -> Result<(), String> {
    let host = parse_host(&api_base)?;
    let addr = (host.as_str(), MSP_DEBUG_PORT)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| "unable to resolve device host".to_string())?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(MSP_DEBUG_TIMEOUT_MS)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(MSP_DEBUG_TIMEOUT_MS)))
        .map_err(|error| error.to_string())?;
    *state
        .stream
        .lock()
        .map_err(|_| "MSP debug state poisoned".to_string())? = Some(stream);
    Ok(())
}

#[tauri::command]
fn msp_debug_disconnect(state: tauri::State<MspDebugState>) -> Result<(), String> {
    if let Some(stream) = state
        .stream
        .lock()
        .map_err(|_| "MSP debug state poisoned".to_string())?
        .take()
    {
        let _ = stream.shutdown(Shutdown::Both);
    }
    Ok(())
}

#[tauri::command]
fn msp_debug_poll(state: tauri::State<MspDebugState>) -> Result<Option<FcDebugSample>, String> {
    let mut guard = state
        .stream
        .lock()
        .map_err(|_| "MSP debug state poisoned".to_string())?;
    let stream = guard
        .as_mut()
        .ok_or_else(|| "MSP debug socket is not connected".to_string())?;
    let request = msp_v2_request(MSP_ELRS_FC_DEBUG);
    stream
        .write_all(&request)
        .map_err(|error| error.to_string())?;

    let mut header = [0u8; 8];
    if !read_exact_timeout(stream, &mut header)? {
        return Ok(None);
    }
    if header[0] != b'$' || header[1] != b'X' || header[2] != b'>' {
        return Err("invalid MSP debug response header".into());
    }
    let function = u16::from_le_bytes([header[4], header[5]]);
    if function != MSP_ELRS_FC_DEBUG {
        return Err(format!("unexpected MSP response function 0x{function:04X}"));
    }
    let payload_len = u16::from_le_bytes([header[6], header[7]]) as usize;
    let mut payload_and_crc = vec![0u8; payload_len + 1];
    if !read_exact_timeout(stream, &mut payload_and_crc)? {
        return Ok(None);
    }
    let mut crc = 0;
    for byte in &header[3..8] {
        crc = crc8_dvb_s2(crc, *byte);
    }
    for byte in &payload_and_crc[..payload_len] {
        crc = crc8_dvb_s2(crc, *byte);
    }
    if crc != payload_and_crc[payload_len] {
        return Err("invalid MSP debug response crc".into());
    }
    parse_debug_payload(&payload_and_crc[..payload_len]).map(Some)
}

#[cfg(desktop)]
mod app_updates {
    use serde::Serialize;
    use std::sync::Mutex;
    use tauri::{ipc::Channel, AppHandle, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    const GITHUB_ENDPOINT: &str =
        "https://github.com/HumpbackLab/glrs-configurator/releases/latest/download/latest.json";
    const GITEE_ENDPOINT: &str =
        "https://raw.giteeusercontent.com/ncer/glrs-configurator/raw/master/updater/latest.json";

    pub struct PendingUpdate(pub Mutex<Option<Update>>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        version: String,
        notes: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateCheckResult {
        current_version: String,
        update: Option<UpdateMetadata>,
    }

    #[derive(Clone, Serialize)]
    #[serde(tag = "event", content = "data")]
    pub enum DownloadEvent {
        #[serde(rename_all = "camelCase")]
        Started { content_length: Option<u64> },
        #[serde(rename_all = "camelCase")]
        Progress { chunk_length: usize },
        Finished,
    }

    fn endpoint_for_source(source: &str) -> Result<&'static str, String> {
        match source {
            "gitee" => Ok(GITEE_ENDPOINT),
            "github" => Ok(GITHUB_ENDPOINT),
            _ => Err(format!("unknown update source: {source}")),
        }
    }

    #[tauri::command]
    pub async fn check_app_update(
        app: AppHandle,
        source: String,
        pending: State<'_, PendingUpdate>,
    ) -> Result<UpdateCheckResult, String> {
        let endpoint = endpoint_for_source(&source)?
            .parse()
            .map_err(|error| format!("invalid updater endpoint: {error}"))?;
        let update = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())?;
        let metadata = update.as_ref().map(|update| UpdateMetadata {
            version: update.version.clone(),
            notes: update.body.clone(),
        });
        *pending.0.lock().map_err(|_| "update state poisoned")? = update;
        Ok(UpdateCheckResult {
            current_version: app.package_info().version.to_string(),
            update: metadata,
        })
    }

    #[tauri::command]
    pub async fn install_app_update(
        pending: State<'_, PendingUpdate>,
        on_event: Channel<DownloadEvent>,
    ) -> Result<(), String> {
        let update = pending
            .0
            .lock()
            .map_err(|_| "update state poisoned")?
            .take()
            .ok_or_else(|| "no pending update".to_string())?;
        let mut started = false;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    if !started {
                        let _ = on_event.send(DownloadEvent::Started { content_length });
                        started = true;
                    }
                    let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                },
                || {
                    let _ = on_event.send(DownloadEvent::Finished);
                },
            )
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MspDebugState {
            stream: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.manage(app_updates::PendingUpdate(Mutex::new(None)));
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            msp_debug_connect,
            msp_debug_disconnect,
            msp_debug_poll,
            #[cfg(desktop)]
            app_updates::check_app_update,
            #[cfg(desktop)]
            app_updates::install_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gyro ELRS Configurator");
}
