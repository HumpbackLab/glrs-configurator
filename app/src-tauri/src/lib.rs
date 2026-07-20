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
        Started {
            content_length: Option<u64>,
        },
        #[serde(rename_all = "camelCase")]
        Progress {
            chunk_length: usize,
        },
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

mod firmware_updates {
    use reqwest::{Client, Url};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{
        ipc::{Channel, Response},
        AppHandle, Manager, State,
    };

    const GITHUB_MANIFEST: &str =
        "https://github.com/HumpbackLab/Gyro-ELRS/releases/latest/download/firmware-latest.json";
    const GITEE_MANIFEST: &str =
        "https://raw.giteeusercontent.com/ncer/Gyro-ELRS/raw/elrs_fc/updater/firmware-latest.json";
    const GITHUB_DOWNLOAD_PREFIX: &str =
        "https://github.com/HumpbackLab/Gyro-ELRS/releases/download/";
    const GITEE_DOWNLOAD_PREFIX: &str = "https://gitee.com/ncer/Gyro-ELRS/releases/download/";
    const GITHUB_RELEASE_API: &str =
        "https://api.github.com/repos/HumpbackLab/Gyro-ELRS/releases/tags/";
    const GITEE_RELEASE_API: &str = "https://gitee.com/api/v5/repos/ncer/Gyro-ELRS/releases/tags/";
    const MAX_FIRMWARE_SIZE: u64 = 8 * 1024 * 1024;

    #[derive(Deserialize)]
    struct FirmwareManifest {
        schema: u32,
        version: String,
        published_at: String,
        #[serde(default)]
        notes: Option<String>,
        firmwares: Vec<FirmwareEntry>,
    }

    #[derive(Deserialize)]
    struct ReleaseMetadata {
        body: Option<String>,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct FirmwareEntry {
        product_name: String,
        target: String,
        filename: String,
        size: u64,
        sha256: String,
        sources: FirmwareSources,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct FirmwareSources {
        github: String,
        gitee: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DeviceFirmware {
        product_name: String,
        target: String,
        version: String,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FirmwareMetadata {
        product_name: String,
        target: String,
        filename: String,
        size: u64,
        sha256: String,
        version: String,
        published_at: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FirmwareCheckResult {
        current_version: String,
        latest_version: String,
        notes: String,
        update: Option<FirmwareMetadata>,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DownloadedFirmware {
        path: String,
        filename: String,
    }

    #[derive(Clone, Serialize)]
    #[serde(tag = "event", content = "data")]
    pub enum DownloadEvent {
        #[serde(rename_all = "camelCase")]
        Started {
            content_length: Option<u64>,
        },
        #[serde(rename_all = "camelCase")]
        Progress {
            chunk_length: usize,
        },
        Finished,
    }

    struct PendingFirmware {
        entry: FirmwareEntry,
        source: String,
    }

    #[derive(Clone)]
    struct StoredDownloadedFirmware {
        result: DownloadedFirmware,
        size: u64,
        sha256: String,
    }

    pub struct PendingFirmwareUpdate(Mutex<Option<PendingFirmware>>);

    pub struct DownloadedFirmwareUpdate(Mutex<Option<StoredDownloadedFirmware>>);

    impl PendingFirmwareUpdate {
        pub fn new() -> Self {
            Self(Mutex::new(None))
        }
    }

    impl DownloadedFirmwareUpdate {
        pub fn new() -> Self {
            Self(Mutex::new(None))
        }
    }

    fn select_firmware(
        firmwares: Vec<FirmwareEntry>,
        device: Option<&DeviceFirmware>,
    ) -> Result<FirmwareEntry, String> {
        let Some(device) = device else {
            let mut firmwares = firmwares.into_iter();
            let entry = firmwares
                .next()
                .ok_or_else(|| "firmware manifest is empty".to_string())?;
            if firmwares.next().is_some() {
                return Err("connect the receiver before selecting from multiple firmwares".into());
            }
            return Ok(entry);
        };

        let same_target = |entry: &&FirmwareEntry| {
            entry
                .target
                .trim()
                .eq_ignore_ascii_case(device.target.trim())
        };
        if let Some(entry) = firmwares.iter().find(|entry| {
            same_target(entry)
                && entry
                    .product_name
                    .trim()
                    .eq_ignore_ascii_case(device.product_name.trim())
        }) {
            return Ok(entry.clone());
        }

        let mut target_matches = firmwares.iter().filter(same_target);
        let entry = target_matches
            .next()
            .ok_or_else(|| "no compatible firmware found for this device".to_string())?;
        if target_matches.next().is_some() {
            return Err(
                "multiple firmwares use this target; an exact product name match is required"
                    .into(),
            );
        }
        Ok(entry.clone())
    }

    fn manifest_endpoint(source: &str) -> Result<&'static str, String> {
        match source {
            "github" => Ok(GITHUB_MANIFEST),
            "gitee" => Ok(GITEE_MANIFEST),
            _ => Err(format!("unknown firmware source: {source}")),
        }
    }

    fn release_notes_endpoint(source: &str, version: &str) -> Result<Url, String> {
        let base = match source {
            "github" => GITHUB_RELEASE_API,
            "gitee" => GITEE_RELEASE_API,
            _ => return Err(format!("unknown firmware source: {source}")),
        };
        let mut url = Url::parse(base).map_err(|error| error.to_string())?;
        url.path_segments_mut()
            .map_err(|_| "release notes URL cannot be a base".to_string())?
            .pop_if_empty()
            .push(version);
        Ok(url)
    }

    async fn fetch_release_notes(client: &Client, source: &str, version: &str) -> String {
        let Ok(url) = release_notes_endpoint(source, version) else {
            return String::new();
        };
        let response = client
            .get(url)
            .header("User-Agent", "gyro-elrs-configurator")
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        let Ok(response) = response.and_then(|response| response.error_for_status()) else {
            return String::new();
        };
        response
            .json::<ReleaseMetadata>()
            .await
            .ok()
            .and_then(|release| release.body)
            .unwrap_or_default()
    }

    fn download_url(entry: &FirmwareEntry, source: &str) -> Result<String, String> {
        let (url, prefix) = match source {
            "github" => (&entry.sources.github, GITHUB_DOWNLOAD_PREFIX),
            "gitee" => (&entry.sources.gitee, GITEE_DOWNLOAD_PREFIX),
            _ => return Err(format!("unknown firmware source: {source}")),
        };
        if !url.starts_with(prefix) {
            return Err("firmware download URL is not from the selected source".into());
        }
        Ok(url.clone())
    }

    fn display_version(version: &str) -> String {
        version
            .split_whitespace()
            .next()
            .unwrap_or(version)
            .to_string()
    }

    fn safe_filename(filename: &str) -> Result<&str, String> {
        let path = Path::new(filename);
        if path.file_name().and_then(|name| name.to_str()) != Some(filename) {
            return Err("invalid firmware filename".into());
        }
        Ok(filename)
    }

    fn available_path(download_dir: &Path, filename: &str) -> PathBuf {
        let requested = download_dir.join(filename);
        if !requested.exists() {
            return requested;
        }
        let path = Path::new(filename);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("firmware");
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bin");
        for suffix in 1..1000 {
            let candidate = download_dir.join(format!("{stem} ({suffix}).{extension}"));
            if !candidate.exists() {
                return candidate;
            }
        }
        download_dir.join(format!("{stem}-download.{extension}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn firmware_entry(gitee_url: &str) -> FirmwareEntry {
            FirmwareEntry {
                product_name: "LightFin Nano 2.4GHz RX".into(),
                target: "Unified_ESP32C3_2400_RX".into(),
                filename: "LightFin.Nano.2.4GHz.RX_v0.9.1_e364.bin".into(),
                size: 1_110_672,
                sha256: "0b96993dc321962d93b8298358c04d8fd6741bc3825cd8b09389d210c1efb7af"
                    .into(),
                sources: FirmwareSources {
                    github: "https://github.com/HumpbackLab/Gyro-ELRS/releases/download/v0.9.1_e364/LightFin.Nano.2.4GHz.RX_v0.9.1_e364.bin".into(),
                    gitee: gitee_url.into(),
                },
            }
        }

        #[test]
        fn accepts_gitee_release_download_url() {
            let url = "https://gitee.com/ncer/Gyro-ELRS/releases/download/v0.9.1_e364/LightFin.Nano.2.4GHz.RX_v0.9.1_e364.bin";
            let entry = firmware_entry(url);

            assert_eq!(download_url(&entry, "gitee").unwrap(), url);
        }

        #[test]
        fn rejects_gitee_url_outside_release_download_prefix() {
            let entry = firmware_entry(
                "https://gitee.com/ncer/Gyro-ELRS/releases/other/v0.9.1_e364/firmware.bin",
            );

            assert_eq!(
                download_url(&entry, "gitee").unwrap_err(),
                "firmware download URL is not from the selected source"
            );
        }

        #[test]
        fn builds_release_notes_urls_for_each_source() {
            assert_eq!(
                release_notes_endpoint("github", "v0.9.2_e364")
                    .unwrap()
                    .as_str(),
                "https://api.github.com/repos/HumpbackLab/Gyro-ELRS/releases/tags/v0.9.2_e364"
            );
            assert_eq!(
                release_notes_endpoint("gitee", "v0.9.2_e364")
                    .unwrap()
                    .as_str(),
                "https://gitee.com/api/v5/repos/ncer/Gyro-ELRS/releases/tags/v0.9.2_e364"
            );
        }

        #[test]
        fn selects_unique_target_when_product_name_changed() {
            let entry = firmware_entry(
                "https://gitee.com/ncer/Gyro-ELRS/releases/download/v0.9.1_e364/firmware.bin",
            );
            let device = DeviceFirmware {
                product_name: "Older LightFin product name".into(),
                target: entry.target.clone(),
                version: "v0.9.0".into(),
            };

            let selected = select_firmware(vec![entry.clone()], Some(&device)).unwrap();
            assert_eq!(selected.product_name, entry.product_name);
        }

        #[test]
        fn refuses_ambiguous_target_without_exact_product_match() {
            let first = firmware_entry(
                "https://gitee.com/ncer/Gyro-ELRS/releases/download/v0.9.1_e364/first.bin",
            );
            let mut second = first.clone();
            second.product_name = "Another receiver".into();
            let device = DeviceFirmware {
                product_name: "Unknown receiver".into(),
                target: first.target.clone(),
                version: "v0.9.0".into(),
            };

            assert_eq!(
                select_firmware(vec![first, second], Some(&device)).unwrap_err(),
                "multiple firmwares use this target; an exact product name match is required"
            );
        }
    }

    #[tauri::command]
    pub async fn check_firmware_update(
        device: Option<DeviceFirmware>,
        source: String,
        pending: State<'_, PendingFirmwareUpdate>,
    ) -> Result<FirmwareCheckResult, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(manifest_endpoint(&source)?)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let manifest: FirmwareManifest =
            response.json().await.map_err(|error| error.to_string())?;
        if manifest.schema != 1 {
            return Err(format!(
                "unsupported firmware manifest schema {}",
                manifest.schema
            ));
        }
        let notes = manifest
            .notes
            .as_deref()
            .filter(|notes| !notes.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(String::new);
        let notes = if notes.is_empty() {
            fetch_release_notes(&client, &source, &manifest.version).await
        } else {
            notes
        };
        let entry = select_firmware(manifest.firmwares, device.as_ref())?;
        if entry.size == 0 || entry.size > MAX_FIRMWARE_SIZE {
            return Err("firmware size is invalid".into());
        }
        if entry.sha256.len() != 64 || !entry.sha256.chars().all(|value| value.is_ascii_hexdigit())
        {
            return Err("firmware SHA-256 is invalid".into());
        }
        safe_filename(&entry.filename)?;
        download_url(&entry, &source)?;

        let current_version = device
            .as_ref()
            .map(|device| display_version(&device.version))
            .unwrap_or_default();
        let update = if !current_version.is_empty() && current_version == manifest.version {
            None
        } else {
            Some(FirmwareMetadata {
                product_name: entry.product_name.clone(),
                target: entry.target.clone(),
                filename: entry.filename.clone(),
                size: entry.size,
                sha256: entry.sha256.clone(),
                version: manifest.version.clone(),
                published_at: manifest.published_at.clone(),
            })
        };
        *pending
            .0
            .lock()
            .map_err(|_| "firmware update state poisoned")? =
            update.as_ref().map(|_| PendingFirmware { entry, source });

        Ok(FirmwareCheckResult {
            current_version,
            latest_version: manifest.version,
            notes,
            update,
        })
    }

    #[tauri::command]
    pub async fn download_firmware_update(
        app: AppHandle,
        pending: State<'_, PendingFirmwareUpdate>,
        downloaded_firmware: State<'_, DownloadedFirmwareUpdate>,
        on_event: Channel<DownloadEvent>,
    ) -> Result<DownloadedFirmware, String> {
        let pending = pending
            .0
            .lock()
            .map_err(|_| "firmware update state poisoned")?
            .take()
            .ok_or_else(|| "no pending firmware update".to_string())?;
        let url = download_url(&pending.entry, &pending.source)?;
        let mut response = Client::builder()
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|error| error.to_string())?
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_FIRMWARE_SIZE)
        {
            return Err("firmware download is too large".into());
        }

        let download_dir = app
            .path()
            .download_dir()
            .map_err(|error| error.to_string())?;
        let destination = available_path(&download_dir, safe_filename(&pending.entry.filename)?);
        let temporary = destination.with_extension("bin.part");
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let _ = on_event.send(DownloadEvent::Started {
            content_length: response.content_length(),
        });
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            downloaded += chunk.len() as u64;
            if downloaded > MAX_FIRMWARE_SIZE {
                let _ = fs::remove_file(&temporary);
                return Err("firmware download is too large".into());
            }
            file.write_all(&chunk).map_err(|error| error.to_string())?;
            hasher.update(&chunk);
            let _ = on_event.send(DownloadEvent::Progress {
                chunk_length: chunk.len(),
            });
        }
        drop(file);

        let actual_sha256 = format!("{:x}", hasher.finalize());
        if downloaded != pending.entry.size
            || actual_sha256 != pending.entry.sha256.to_ascii_lowercase()
        {
            let _ = fs::remove_file(&temporary);
            return Err("downloaded firmware failed size or SHA-256 verification".into());
        }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        let _ = on_event.send(DownloadEvent::Finished);

        let downloaded_firmware_result = DownloadedFirmware {
            filename: destination
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&pending.entry.filename)
                .to_string(),
            path: destination.to_string_lossy().to_string(),
        };
        let stored_downloaded_firmware = StoredDownloadedFirmware {
            result: downloaded_firmware_result.clone(),
            size: pending.entry.size,
            sha256: pending.entry.sha256,
        };
        *downloaded_firmware
            .0
            .lock()
            .map_err(|_| "downloaded firmware state poisoned")? = Some(stored_downloaded_firmware);
        Ok(downloaded_firmware_result)
    }

    #[tauri::command]
    pub fn load_downloaded_firmware(
        downloaded_firmware: State<'_, DownloadedFirmwareUpdate>,
    ) -> Result<Response, String> {
        let firmware = downloaded_firmware
            .0
            .lock()
            .map_err(|_| "downloaded firmware state poisoned")?
            .clone()
            .ok_or_else(|| "no downloaded firmware is available".to_string())?;
        let bytes = fs::read(&firmware.result.path).map_err(|error| error.to_string())?;
        let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as u64 != firmware.size
            || actual_sha256 != firmware.sha256.to_ascii_lowercase()
        {
            return Err("downloaded firmware failed size or SHA-256 verification".into());
        }
        Ok(Response::new(bytes))
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
            app.manage(firmware_updates::PendingFirmwareUpdate::new());
            app.manage(firmware_updates::DownloadedFirmwareUpdate::new());
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
            app_updates::install_app_update,
            firmware_updates::check_firmware_update,
            firmware_updates::download_firmware_update,
            firmware_updates::load_downloaded_firmware
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gyro ELRS Configurator");
}
