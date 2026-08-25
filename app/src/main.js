import './styles.css';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import { t, setLocale, getLocale } from './i18n.js';

const DEFAULT_API = 'http://10.0.0.1';
const API_STORAGE_KEY = 'elrs-local-rx-api';
const LOCAL_PROXY_PATH = '/__elrs_proxy__';
const UPDATE_SOURCE_STORAGE_KEY = 'elrs-app-update-source';
const BEGINNER_MODE_STORAGE_KEY = 'elrs-beginner-mode';
const PROFILE_FORMAT = 'gyro-elrs-profile';
const PROFILE_VERSION = 1;
const PROFILE_SUBMISSION_FORMAT = 'gyro-elrs-profile-submission';
const PROFILE_SUBMISSION_VERSION = 1;
const PROFILE_SUBMISSION_API = import.meta.env.VITE_PROFILE_SUBMISSION_URL
  || 'https://share.humpbacklab.com/api/submissions';
const PROFILE_CATALOG_API = import.meta.env.VITE_PROFILE_CATALOG_URL
  || 'https://share.humpbacklab.com/catalog.json';
const AIRCRAFT_MODEL_URL = `${import.meta.env.BASE_URL}models/model_rudderless_plane.gltf`;

function defaultUpdateSource() {
  return getLocale() === 'zh-CN' ? 'gitee' : 'github';
}

function loadUpdateSource() {
  const stored = localStorage.getItem(UPDATE_SOURCE_STORAGE_KEY);
  return stored === 'gitee' || stored === 'github' ? stored : defaultUpdateSource();
}

function loadBeginnerMode() {
  return localStorage.getItem(BEGINNER_MODE_STORAGE_KEY) === '1';
}

const state = {
  apiBase: loadApiBase(),
  tab: 'status',
  target: null,
  configResponse: null,
  hardware: null,
  bindingPhrase: '',
  originalUid: [],
  originalUidType: '',
  networks: [],
  message: null,
  busy: false,
  connectionStatus: 'idle',
  uploadResult: null,
  uploadProgress: null,
  updateSource: loadUpdateSource(),
  beginnerMode: loadBeginnerMode(),
  appUpdate: {
    status: 'idle',
    currentVersion: '',
    version: '',
    notes: '',
    downloaded: 0,
    total: 0,
    error: '',
  },
  firmwareUpdate: {
    status: 'idle',
    currentVersion: '',
    latestVersion: '',
    notes: '',
    productName: '',
    target: '',
    filename: '',
    downloaded: 0,
    total: 0,
    path: '',
    compatible: null,
    error: '',
  },
  extraMixerRows: 0,
  orientationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  orientationCal: {
    busy: false,
    samples: Array(2).fill(null),
    levelCorrectionDeg: null,
    baseMatrix: null,
  },
  imuCalibration: {
    busy: '',
    accelFaces: Array(6).fill(null),
    accelBias: null,
    accelScale: null,
    gyroBias: null,
  },
  debugSample: null,
  debugError: '',
  debugPolling: false,
  debugPollRateHz: 20,
  pidLogError: '',
  pidLogMode: 'rate',
  pidLogSamples: [],
  pidLogVisible: {},
  pidLiveReceiving: false,
  pidLiveStarting: false,
  pidLivePackets: 0,
  pidLiveDuplicates: 0,
  pidLiveLastSequence: null,
  pidLiveRateHz: 0,
  pidLiveWindowSeconds: 10,
  pidChartViews: {},
  pidChartHover: {},
  profileDraft: null,
  profileOriginal: null,
  profileCompatibility: null,
  profileImportError: '',
  communitySubmission: {
    open: false,
    profile: null,
    fileName: '',
    result: null,
  },
  communityCatalog: {
    open: false,
    status: 'idle',
    profiles: [],
    generatedAt: '',
    query: '',
    vehicleType: '',
    busyId: '',
    usageProfileId: '',
    usageById: {},
    usageLoadingById: {},
    error: '',
  },
};

let debugPollTimer = null;
let debugPollInFlight = false;
let debugPollGeneration = 0;
let mspDebugConnected = false;
let mspDebugConnectPromise = null;
let debugAircraftView = null;
let orientationAircraftView = null;
let pwmRuntimeUpdateTimer = null;
let pwmRuntimeUpdateInFlight = false;
let pwmRuntimePendingValues = null;
let pidLiveRateWindow = [];
let connectionHealthTimer = null;
let connectionHealthInFlight = false;
let connectionHealthFailures = 0;

const CONNECTION_HEALTH_INTERVAL_MS = 2000;
const CONNECTION_HEALTH_TIMEOUT_MS = 1500;
const CONNECTION_HEALTH_FAILURE_LIMIT = 2;

const DEG_TO_RAD = Math.PI / 180;

const tabs = [
  ['status', () => t('tab.status')],
  ['runtime', () => t('tab.runtime')],
  ['model', () => t('tab.model')],
  ['pwm', () => t('tab.pwm')],
  ['flight', () => t('tab.flight')],
  ['debug', () => t('tab.debug')],
  ['hardware', () => t('tab.hardware')],
  ['wifi', () => t('tab.wifi')],
  ['update', () => t('tab.update')],
];

const serialProtocols = [
  ['0', 'CRSF'],
  ['1', 'Inverted CRSF'],
  ['2', 'SBUS'],
  ['3', 'Inverted SBUS'],
  ['4', 'SUMD'],
  ['5', 'DJI RS Pro'],
  ['6', 'HoTT Telemetry'],
  ['7', 'MAVLINK'],
];

const serial1Protocols = [
  ['0', 'Off'],
  ['1', 'CRSF'],
  ['2', 'Inverted CRSF'],
  ['3', 'SBUS'],
  ['4', 'Inverted SBUS'],
  ['5', 'SUMD'],
  ['6', 'DJI RS Pro'],
  ['7', 'HoTT Telemetry'],
  ['8', 'Tramp'],
  ['9', 'SmartAudio'],
];

const pwmModes = [
  '50Hz',
  '60Hz',
  '100Hz',
  '160Hz',
  '333Hz',
  '400Hz',
  '10KHzDuty',
  'On/Off',
  'DShot',
  'Serial RX',
  'Serial TX',
  'I2C SCL',
  'I2C SDA',
  'Serial2 RX',
  'Serial2 TX',
];

const pwmInputLabels = [
  'ch1',
  'ch2',
  'ch3',
  'ch4',
  'ch5 (AUX1)',
  'ch6 (AUX2)',
  'ch7 (AUX3)',
  'ch8 (AUX4)',
  'ch9 (AUX5)',
  'ch10 (AUX6)',
  'ch11 (AUX7)',
  'ch12 (AUX8)',
  'ch13 (AUX9)',
  'ch14 (AUX10)',
  'ch15 (AUX11)',
  'ch16 (AUX12)',
];

const pwmFailsafeModes = [
  () => t('pwmFailsafe.setPosition'),
  () => t('pwmFailsafe.noPulses'),
  () => t('pwmFailsafe.lastPosition'),
];

const bindStorage = [
  ['0', () => t('bindStorage.persistent')],
  ['1', () => t('bindStorage.volatile')],
  ['2', () => t('bindStorage.returnable')],
  ['3', () => t('bindStorage.administered')],
];

const runtimeDefaults = {
  'wifi-on-interval': '',
  'rcvr-uart-baud': 420000,
  'lock-on-first-connection': true,
  'is-airport': false,
};

const modelDefaults = {
  vbind: 0,
  modelid: 255,
  'serial-protocol': 0,
  'sbus-failsafe': 0,
  'force-tlm': false,
};

function normalizeApiBase(value) {
  const trimmed = (value || DEFAULT_API).trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function apiBaseHost() {
  return state.apiBase.replace(/^https?:\/\//i, '');
}

function loadApiBase() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('api') || params.get('host');
  const value = normalizeApiBase(requested || localStorage.getItem(API_STORAGE_KEY) || DEFAULT_API);
  localStorage.setItem(API_STORAGE_KEY, value);
  return value;
}

function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    const url = new URL(`${window.location.origin}${LOCAL_PROXY_PATH}${normalizedPath}`);
    url.searchParams.set('target', state.apiBase);
    return url.toString();
  }
  return `${state.apiBase}${normalizedPath}`;
}

async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 5000);
  const response = await fetch(apiUrl(path), {
    ...options,
    signal: controller.signal,
    headers: {
      ...(options.body instanceof FormData ? {} : {'Content-Type': 'application/json'}),
      ...(options.headers || {}),
    },
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error(t('error.timeout', {host: state.apiBase}));
    throw error;
  }).finally(() => {
    window.clearTimeout(timeout);
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${response.status} ${detail}`);
  }
  return body;
}

async function apiFetchBlob(path, timeout = 30000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  const response = await fetch(apiUrl(path), {signal: controller.signal}).catch((error) => {
    if (error.name === 'AbortError') throw new Error(t('error.timeout', {host: state.apiBase}));
    throw error;
  }).finally(() => {
    window.clearTimeout(timer);
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.blob();
}

function xhrRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeout = 5000,
    onUploadProgress = null,
  } = options;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, apiUrl(path), true);
    xhr.timeout = timeout;

    Object.entries(headers).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        xhr.setRequestHeader(key, value);
      }
    });

    if (typeof onUploadProgress === 'function' && xhr.upload) {
      xhr.upload.onprogress = onUploadProgress;
    }

    xhr.onload = () => {
      const contentType = xhr.getResponseHeader('content-type') || '';
      const bodyText = xhr.responseText || '';
      let parsedBody = bodyText;
      if (contentType.includes('application/json')) {
        try {
          parsedBody = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          parsedBody = bodyText;
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
        reject(new Error(`${xhr.status} ${detail}`));
        return;
      }
      resolve(parsedBody);
    };

    xhr.onerror = () => reject(new Error(t('error.failedConnect', {host: state.apiBase})));
    xhr.ontimeout = () => reject(new Error(t('error.timeout', {host: state.apiBase})));
    xhr.send(body);
  });
}

function setMessage(type, text) {
  state.message = text ? {type, text} : null;
  render();
}

async function runBusy(task, successText) {
  state.busy = true;
  render();
  try {
    await task();
    if (successText) setMessage('ok', successText);
  } catch (error) {
    setMessage('error', error.message || String(error));
  } finally {
    state.busy = false;
    render();
  }
}

function config() {
  return state.configResponse?.config || {};
}

function options() {
  return state.configResponse?.options || {};
}

function hardware() {
  return state.hardware || {};
}

function jsonText(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function selected(value, expected) {
  return String(value ?? '') === String(expected) ? 'selected' : '';
}

function checked(value) {
  return value ? 'checked' : '';
}

function disabled(value) {
  return value ? 'disabled' : '';
}

function bytesToList(value) {
  return Array.isArray(value) ? value.map((item) => Number(item) || 0) : [];
}

function listToPrettyString(value) {
  return bytesToList(value).join(', ');
}

function isValidUidByte(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 && parsed < 256;
}

const md5 = (() => {
  const constants = Array.from(
    {length: 64},
    (_, index) => 0 | (Math.abs(Math.sin(index + 1)) * 4294967296),
  );
  const shifts = [
    7, 12, 17, 22,
    5, 9, 14, 20,
    4, 11, 16, 23,
    6, 10, 15, 21,
  ];

  function calcMD5(input) {
    let bytes;
    if (typeof input === 'string') {
      const encoded = unescape(encodeURI(input));
      bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    } else {
      bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    }

    const words = [];
    for (let index = 0; index < bytes.length; ++index) {
      words[index >> 2] = (words[index >> 2] || 0) | (bytes[index] << (8 * (index % 4)));
    }
    words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | (0x80 << (8 * (bytes.length % 4)));
    const finalLengthIndex = ((bytes.length + 8 >> 6) * 16) + 14;
    words[finalLengthIndex] = bytes.length * 8;

    let hash = [1732584193, -271733879, -1732584194, 271733878];
    for (let block = 0; block < finalLengthIndex; block += 16) {
      let state = hash.slice();
      for (let round = 0; round < 64; ++round) {
        const group = round >> 4;
        const b = state[1];
        const c = state[2];
        const d = state[3];
        const mixed = [
          (b & c) | (~b & d),
          (d & b) | (~d & c),
          b ^ c ^ d,
          c ^ (b | ~d),
        ][group];
        const wordIndex = [round, 5 * round + 1, 3 * round + 5, 7 * round][group] % 16;
        const value = (state[0] + mixed + constants[round] + (words[block + wordIndex] || 0)) | 0;
        const shift = shifts[group * 4 + (round % 4)];
        const rotated = (value << shift) | (value >>> (32 - shift));
        state = [d, (b + rotated) | 0, b, c];
      }
      hash = hash.map((value, index) => (value + state[index]) | 0);
    }

    const output = new Uint8Array(16);
    hash.forEach((value, word) => {
      for (let byte = 0; byte < 4; ++byte) {
        output[word * 4 + byte] = (value >>> (byte * 8)) & 0xff;
      }
    });
    return output;
  }
  return calcMD5;
})();

function pwmConnected() {
  return !!state.target;
}

function pwmEntries() {
  const raw = Array.isArray(config().pwm) ? config().pwm : [];
  if (raw.length > 0) {
    const imported = state.profileDraft?.pwm;
    return raw.map((entry, index) => imported?.[index] === undefined
      ? entry
      : {...entry, config: imported[index]});
  }
  if (state.profileDraft?.pwm) {
    return state.profileDraft.pwm.map((configValue, index) => ({config: configValue, pin: index + 1, features: 127}));
  }
  // Offline fallback: 8 dummy channels with default 50Hz config for UI development
  if (!pwmConnected()) {
    const dummy = []; for (let i = 0; i < 8; i++) dummy.push({config: 0, pin: i + 2, features: 0});
    return dummy;
  }
  return [];
}

function pwmOutputLimits() {
  const configured = Array.isArray(config().fc_pwm_output_limits) ? config().fc_pwm_output_limits : [];
  const imported = state.profileDraft?.pwmLimits;
  return pwmEntries().map((entry, index) => {
    const values = imported?.[index] ?? configured[index];
    if (!Array.isArray(values) || values.length < 3) return [1000, 1500, 2000];
    return [
      intOrDefault(values[0], 1000),
      intOrDefault(values[1], 1500),
      intOrDefault(values[2], 2000),
    ];
  });
}

function pwmOutputWifiEnabled() {
  return Boolean(config().fc_pwm_output_wifi_enabled);
}

function pwmOutputWifiValues() {
  const configured = Array.isArray(config().fc_pwm_output_wifi_values)
    ? config().fc_pwm_output_wifi_values
    : [];
  const limits = pwmOutputLimits();
  return limits.map((range, index) =>
    Math.max(range[0], Math.min(range[2], intOrDefault(configured[index], range[1]))));
}

function decodePwmConfig(rawValue) {
  const raw = Number(rawValue) || 0;
  return {
    failsafe: (raw & 1023) + 988,
    inputChannel: (raw >> 10) & 15,
    inverted: ((raw >> 14) & 1) === 1,
    mode: (raw >> 15) & 15,
    narrow: ((raw >> 19) & 1) === 1,
    failsafeMode: (raw >> 20) & 3,
    signalPolarityInverted: ((raw >> 22) & 1) === 1,
    mixerMode: ((raw >> 23) & 1) === 1,
  };
}

function encodePwmConfig(decoded) {
  const failsafe = Math.max(988, Math.min(2011, intOrDefault(decoded.failsafe, 1500)));
  const inputChannel = Math.max(0, Math.min(15, intOrDefault(decoded.inputChannel, 0)));
  const mode = Math.max(0, Math.min(15, intOrDefault(decoded.mode, 0)));
  const failsafeMode = Math.max(0, Math.min(3, intOrDefault(decoded.failsafeMode, 0)));
  const invert = decoded.inverted ? 1 : 0;
  const narrow = decoded.narrow ? 1 : 0;
  const signalPolarityInverted = decoded.signalPolarityInverted ? 1 : 0;
  const mixerMode = decoded.mixerMode ? 1 : 0;
  return (mixerMode << 23) | (signalPolarityInverted << 22) | (narrow << 19) | (failsafeMode << 20) | (mode << 15) | (invert << 14) | (inputChannel << 10) | (failsafe - 988);
}

function pwmModeAllowed(features, mode) {
  if (mode >= 0 && mode <= 7) return true;
  if (mode === 8) return (features & 16) !== 0;
  if (mode === 9) return (features & 2) !== 0;
  if (mode === 10) return (features & 1) !== 0;
  if (mode === 11) return (features & 4) !== 0;
  if (mode === 12) return (features & 8) !== 0;
  if (mode === 13) return (features & 32) !== 0;
  if (mode === 14) return (features & 64) !== 0;
  return false;
}

function pwmFeatureBadges(features) {
  const badges = [];
  if (features & 1) badges.push(['TX', 'feature-tx']);
  else if (features & 2) badges.push(['RX', 'feature-rx']);

  if ((features & 12) === 12) badges.push(['I2C', 'feature-i2c']);
  else if (features & 4) badges.push(['SCL', 'feature-i2c']);
  else if (features & 8) badges.push(['SDA', 'feature-i2c']);

  if ((features & 96) === 96) badges.push(['Serial2', 'feature-serial2']);
  else if (features & 32) badges.push(['RX2', 'feature-serial2']);
  else if (features & 64) badges.push(['TX2', 'feature-serial2']);

  if (features & 16) badges.push(['DShot', 'feature-dshot']);

  return badges.map(([label, css]) => `<span class="badge ${css}">${label}</span>`).join('');
}

function renderPwmModeOptions(features, selectedMode) {
  return pwmModes.map((label, mode) => {
    if (!pwmModeAllowed(features, mode)) return '';
    return `<option value="${mode}" ${selected(selectedMode, mode)}>${label}</option>`;
  }).join('');
}

function pwmSerial2Active() {
  return pwmEntries().some((entry) => decodePwmConfig(entry.config).mode === 14);
}

function uidBytesFromText(text) {
  if (/^[0-9, ]+$/.test(text)) {
    const asArray = text.split(',').filter(isValidUidByte).map(Number);
    if (asArray.length >= 4 && asArray.length <= 6) {
      while (asArray.length < 6) asArray.unshift(0);
      return asArray;
    }
  }
  const bindingPhraseFull = `-DMY_BINDING_PHRASE="${text}"`;
  return Array.from(md5(bindingPhraseFull).subarray(0, 6));
}

function numCellValue(values, index) {
  const value = Number(values?.[index]);
  return Number.isFinite(value) ? value : 0;
}

function renderNumGridRow(prefix, rowLabel, colCount, values, rowIndex, disabled = '', options = {}) {
  const flagCell = options.flagName
    ? `<td class="grid-check-cell"><input type="checkbox" name="${escapeHtml(options.flagName)}-${rowIndex}" ${checked(Boolean(options.flagValues?.[rowIndex]))} ${disabled}></td>`
    : '';
  return `
    <tr>
      <th scope="row">${escapeHtml(rowLabel)}</th>
      ${Array.from({length: colCount}, (_, colIndex) => {
        const index = rowIndex * colCount + colIndex;
        return `<td><input type="number" step="any" inputmode="decimal" data-grid="${prefix}" data-row="${rowIndex}" data-col="${colIndex}" value="${escapeHtml(numCellValue(values, index))}" ${disabled}></td>`;
      }).join('')}
      ${flagCell}
    </tr>`;
}

function renderNumGrid(prefix, rowLabels, colLabels, values, options = {}) {
  const disabled = options.disabled ? 'disabled' : '';
  const note = options.note ? `<div class="helper">${escapeHtml(options.note)}</div>` : '';
  return `
    <div class="table-shell">
      <table class="grid-table" data-grid-table="${escapeHtml(prefix)}">
        <thead>
          <tr>
            <th>${escapeHtml(options.rowHeader || '')}</th>
            ${colLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}
            ${options.flagName ? `<th>${escapeHtml(options.flagLabel || '')}</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${rowLabels.map((rowLabel, rowIndex) => renderNumGridRow(prefix, rowLabel, colLabels.length, values, rowIndex, disabled, options)).join('')}
        </tbody>
      </table>
      ${note}
    </div>`;
}

function readNumGrid(form, prefix, rowCount, colCount) {
  const values = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const input = form.querySelector(`[data-grid="${prefix}"][data-row="${row}"][data-col="${col}"]`);
      if (!input) {
        throw new Error(t('error.missingCell', {prefix, row: row + 1, col: col + 1}));
      }
      const parsed = Number.parseFloat(input.value);
      if (!Number.isFinite(parsed)) {
        throw new Error(t('error.invalidNumber', {label: prefix, row: row + 1, col: col + 1}));
      }
      values.push(parsed);
    }
  }
  return values;
}

function readMixerServos(form, rowCount) {
  return Array.from({length: rowCount}, (_, row) =>
    Boolean(form.elements[`fc-mixer-servo-${row}`]?.checked));
}

function bindingUidPreview() {
  const text = state.bindingPhrase.trim();
  return text.length === 0 ? state.originalUid : uidBytesFromText(text);
}

function syncBindingPreview() {
  const uidPreview = document.querySelector('#uid-preview');
  const uidType = document.querySelector('#uid-type');
  if (uidPreview) uidPreview.value = listToPrettyString(bindingUidPreview());
  if (uidType) uidType.textContent = state.bindingPhrase.trim().length === 0 ? (state.originalUidType || t('value.unknown')) : t('value.modified');
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function intOrDefault(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadDevice() {
  const [target, configResponse, hardwareResponse] = await Promise.all([
    apiFetch('/target'),
    apiFetch('/config'),
    apiFetch('/hardware.json').catch(() => ({})),
  ]);
  state.target = target;
  state.connectionStatus = 'connected';
  connectionHealthFailures = 0;
  state.configResponse = configResponse;
  state.hardware = hardwareResponse;
  state.imuCalibration = {
    busy: '',
    accelFaces: Array(6).fill(null),
    accelBias: null,
    accelScale: null,
    gyroBias: null,
  };
  const currentFirmwareVersion = (target?.version || '').split(/\s+/, 1)[0];
  const hasDownloadedFirmware = state.firmwareUpdate.status === 'downloaded'
    && Boolean(state.firmwareUpdate.path)
    && Boolean(state.firmwareUpdate.filename);
  const cachedFirmwareMatches = state.firmwareUpdate.latestVersion
    && state.firmwareUpdate.target
    && state.firmwareUpdate.target.trim().toLowerCase() === (target?.target || '').trim().toLowerCase();
  if (cachedFirmwareMatches) {
    state.firmwareUpdate = {
      ...state.firmwareUpdate,
      status: currentFirmwareVersion === state.firmwareUpdate.latestVersion
        ? 'current'
        : (state.firmwareUpdate.path ? 'downloaded' : 'available'),
      currentVersion: currentFirmwareVersion,
      compatible: true,
      error: '',
    };
  } else if (hasDownloadedFirmware) {
    state.firmwareUpdate = {
      ...state.firmwareUpdate,
      status: 'downloaded',
      currentVersion: currentFirmwareVersion,
      compatible: false,
      error: '',
    };
  } else {
    state.firmwareUpdate = {
      ...state.firmwareUpdate,
      status: 'idle',
      currentVersion: currentFirmwareVersion,
      latestVersion: '',
      notes: '',
      productName: '',
      target: '',
      filename: '',
      downloaded: 0,
      total: 0,
      path: '',
      compatible: null,
      error: '',
    };
  }
  state.extraMixerRows = 0;
  state.originalUid = bytesToList(configResponse?.config?.uid);
  state.originalUidType = configResponse?.config?.uidtype || '';
  if (state.profileOriginal) {
    try {
      const {draft} = validateProfile(state.profileOriginal, {deviceAware: true});
      state.profileDraft = draft;
      state.profileImportError = '';
      if (draft.flight) state.orientationMatrix = orientationMatrixOrIdentity(draft.flight.fc_orientation);
    } catch (error) {
      state.profileImportError = error.message || String(error);
    }
  }
  if (!state.profileDraft?.flight) {
    const orient = (configResponse?.config?.fc_orientation || []).length === 9 ? configResponse.config.fc_orientation : [];
    state.orientationMatrix = orientationMatrixOrIdentity(orient);
  }
  state.orientationCal.samples = Array(2).fill(null);
  state.orientationCal.levelCorrectionDeg = null;
  state.orientationCal.baseMatrix = null;
  if (!state.bindingPhrase) {
    state.bindingPhrase = '';
  }
}

async function connectDevice(successText) {
  state.connectionStatus = 'connecting';
  render();
  await runBusy(async () => {
    try {
      await loadDevice();
    } catch (error) {
      state.connectionStatus = 'error';
      state.target = null;
      throw error;
    }
  }, successText);
}

function scheduleConnectionHealthCheck() {
  if (connectionHealthTimer) return;
  connectionHealthTimer = window.setTimeout(async () => {
    connectionHealthTimer = null;
    await checkConnectionHealth();
    scheduleConnectionHealthCheck();
  }, CONNECTION_HEALTH_INTERVAL_MS);
}

async function checkConnectionHealth() {
  if (state.connectionStatus !== 'connected' || state.busy || connectionHealthInFlight) return;
  connectionHealthInFlight = true;
  try {
    await apiFetch('/target', {timeout: CONNECTION_HEALTH_TIMEOUT_MS, cache: 'no-store'});
    connectionHealthFailures = 0;
  } catch {
    connectionHealthFailures += 1;
    if (connectionHealthFailures >= CONNECTION_HEALTH_FAILURE_LIMIT && state.connectionStatus === 'connected') {
      state.connectionStatus = 'idle';
      state.target = null;
      state.configResponse = null;
      state.hardware = null;
      connectionHealthFailures = 0;
      render();
    }
  } finally {
    connectionHealthInFlight = false;
  }
}

function connectionStatusLabel() {
  switch (state.connectionStatus) {
    case 'connected':
      return t('connection.connected');
    case 'connecting':
      return t('connection.connecting');
    case 'error':
      return t('connection.error');
    default:
      return t('connection.disconnected');
  }
}

function configValue(key, fallback) {
  const value = config()[key];
  return value === undefined ? fallback : value;
}

function flightConfigValue(key, fallback) {
  const draft = state.profileDraft?.flight;
  if (draft && Object.hasOwn(draft, key)) return draft[key];
  return configValue(key, fallback);
}

function optionValue(key, fallback) {
  const value = options()[key];
  return value === undefined ? fallback : value;
}

async function saveRuntime(event) {
  event.preventDefault();
  const data = readForm(event.currentTarget);
  const next = {
    customised: true,
    'wifi-on-interval': data['wifi-on-interval'] === '' ? -1 : intOrDefault(data['wifi-on-interval'], -1),
    'rcvr-uart-baud': intOrDefault(data['rcvr-uart-baud'], runtimeDefaults['rcvr-uart-baud']),
    'lock-on-first-connection': Boolean(data['lock-on-first-connection']),
    'is-airport': Boolean(data['is-airport']),
    'flash-discriminator': options()['flash-discriminator'] || '',
    'wifi-ssid': options()['wifi-ssid'] || '',
    'wifi-password': options()['wifi-password'] || '',
  };
  await runBusy(async () => {
    await apiFetch('/options.json', {method: 'POST', body: JSON.stringify(next)});
    await loadDevice();
  }, t('message.runtimeSaved'));
}

async function saveModel(event) {
  event.preventDefault();
  const data = readForm(event.currentTarget);
  const uid = state.bindingPhrase.trim().length === 0 ? state.originalUid : uidBytesFromText(state.bindingPhrase.trim());
  const payload = {
    ...config(),
    uid,
    vbind: intOrDefault(data.vbind, modelDefaults.vbind),
    modelid: data['model-match'] ? intOrDefault(data.modelid, modelDefaults.modelid) : 255,
    'serial-protocol': intOrDefault(data['serial-protocol'], modelDefaults['serial-protocol']),
    'sbus-failsafe': intOrDefault(data['sbus-failsafe'], modelDefaults['sbus-failsafe']),
    'force-tlm': data['force-tlm'] ? 1 : 0,
  };
  delete payload.pwm;
  await runBusy(async () => {
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(payload)});
    await loadDevice();
  }, t('message.modelSaved'));
}

async function savePwm(event) {
  event.preventDefault();
  if (!pwmConnected()) return;
  if (state.profileImportError) {
    setMessage('error', state.profileImportError);
    return;
  }
  const form = event.currentTarget;
  const entries = pwmEntries();
  const usedExclusiveModes = new Map();
  const limits = pwmOutputLimits();
  const nextPwm = entries.map((entry, index) => {
    const mode = intOrDefault(form.elements[`pwm-mode-${index}`]?.value, 0);
    const decoded = {
      mode,
      inputChannel: intOrDefault(form.elements[`pwm-input-${index}`]?.value, 0),
      inverted: form.elements[`pwm-invert-${index}`]?.checked,
      signalPolarityInverted: form.elements[`pwm-polarity-${index}`]?.checked,
      narrow: form.elements[`pwm-narrow-${index}`]?.checked,
      failsafeMode: intOrDefault(form.elements[`pwm-failsafe-mode-${index}`]?.value, 0),
      failsafe: intOrDefault(form.elements[`pwm-failsafe-${index}`]?.value, 1500),
      mixerMode: intOrDefault(form.elements[`pwm-source-${index}`]?.value, 0) == 1,
    };
    if (mode > 9) {
      if (usedExclusiveModes.has(mode)) {
        throw new Error(t('error.pwmExclusive', {mode: pwmModes[mode], output: usedExclusiveModes.get(mode)}));
      }
      usedExclusiveModes.set(mode, index + 1);
    }
    return encodePwmConfig(decoded);
  });
  const nextPwmLimits = entries.map((entry, index) => {
    const min = intOrDefault(form.elements[`pwm-limit-min-${index}`]?.value, limits[index][0]);
    const center = intOrDefault(form.elements[`pwm-limit-center-${index}`]?.value, limits[index][1]);
    const max = intOrDefault(form.elements[`pwm-limit-max-${index}`]?.value, limits[index][2]);
    if (min < 500 || max > 2500 || min >= center || center >= max) {
      throw new Error(`${t('message.invalidRange')}: ${t('pwm.output')} ${index + 1}`);
    }
    return [min, center, max];
  });

  const payload = {
    ...config(),
    pwm: nextPwm,
    fc_pwm_output_limits: nextPwmLimits,
    'serial1-protocol': pwmSerial2Active() ? configValue('serial1-protocol', 0) : 0,
  };

  const serial2Input = form.elements['serial1-protocol'];
  if (serial2Input) {
    payload['serial1-protocol'] = intOrDefault(serial2Input.value, 0);
  }

  await runBusy(async () => {
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(payload)});
    if (state.profileDraft) {
      state.profileDraft.pwm = null;
      state.profileDraft.pwmLimits = null;
      state.profileDraft.serial1Protocol = null;
      if (!state.profileDraft.flight) state.profileDraft = null;
    }
    markProfileSectionApplied('pwm');
    await loadDevice();
  }, t('message.pwmSaved'));
}

async function saveFlight(event) {
  event.preventDefault();
  if (!state.target) return;
  if (state.profileImportError) {
    setMessage('error', state.profileImportError);
    return;
  }
  if (state.beginnerMode) {
    await saveBeginnerFlightOrientation(event.currentTarget);
    return;
  }
  const form = event.currentTarget;
  const nextConfig = {...config()};
  await runBusy(async () => {
    nextConfig.fc_mode_conditions = {};
    ['rate', 'angle'].forEach((mode) => {
      if (!form[`fc_${mode}_enabled`].checked) return;
      const channel = intOrDefault(form[`fc_${mode}_channel`].value, 6);
      const start = intOrDefault(form[`fc_${mode}_start`].value, 0);
      const end = intOrDefault(form[`fc_${mode}_end`].value, 0);
      if (start < 900 || end > 2100 || start >= end) throw new Error(`${t('message.invalidRange')}: ${mode.toUpperCase()}`);
      nextConfig.fc_mode_conditions[mode] = [channel, start, end];
    });
    nextConfig.fc_wifi_conditions = {};
    if (form.fc_wifi_coexist_enabled.checked) {
      const channel = intOrDefault(form.fc_wifi_coexist_channel.value, 7);
      const start = intOrDefault(form.fc_wifi_coexist_start.value, 0);
      const end = intOrDefault(form.fc_wifi_coexist_end.value, 0);
      if (start < 900 || end > 2100 || start >= end) throw new Error(`${t('message.invalidRange')}: ${t('flight.wifiCoexist')}`);
      nextConfig.fc_wifi_conditions.coexist = [channel, start, end];
    }
    nextConfig.fc_arm_enabled = form.fc_arm_enabled.checked;
    nextConfig.fc_arm_channel = intOrDefault(form.fc_arm_channel.value, 5);
    const armStart = intOrDefault(form.fc_arm_start.value, 0);
    const armEnd = intOrDefault(form.fc_arm_end.value, 0);
    if (armStart < 900 || armEnd > 2100 || armStart >= armEnd) throw new Error(`${t('message.invalidRange')}: ARM`);
    nextConfig.fc_arm_range = [armStart, armEnd];
    nextConfig.fc_rate_pid = readNumGrid(form, 'fc_rate_pid', 3, 4);
    const angleEnabled = form.fc_angle_enabled.checked;
    if (angleEnabled) {
      nextConfig.fc_angle_pid = readNumGrid(form, 'fc_angle_pid', 3, 4);
      const angleRateLimits = [
        Number(form.fc_angle_rate_limit_roll_dps.value),
        Number(form.fc_angle_rate_limit_pitch_dps.value),
      ];
      if (angleRateLimits.some((value) => !Number.isInteger(value) || value < 1 || value > 1000)) {
        throw new Error(t('error.invalidAngleRateLimit'));
      }
      nextConfig.fc_angle_rate_limits_dps = angleRateLimits;
    }
    const dtermLpfHz = intOrDefault(form.fc_dterm_lpf_hz.value, 20);
    if (dtermLpfHz < 0 || dtermLpfHz > 100 || (dtermLpfHz > 0 && dtermLpfHz < 5)) {
      throw new Error(t('error.invalidDtermLpf'));
    }
    nextConfig.fc_dterm_lpf_hz = dtermLpfHz;
    const gyroLpfHz = intOrDefault(form.fc_gyro_lpf_hz.value, 30);
    if (gyroLpfHz < 0 || gyroLpfHz > 100 || (gyroLpfHz > 0 && gyroLpfHz < 5)) {
      throw new Error(t('error.invalidGyroLpf'));
    }
    nextConfig.fc_gyro_lpf_hz = gyroLpfHz;
    nextConfig.fc_gyro_bias_mode = intOrDefault(form.fc_gyro_bias_mode.value, 0);
    nextConfig.fc_mixer = readNumGrid(form, 'fc_mixer', motorCount(), 4);
    nextConfig.fc_mixer_servos = readMixerServos(form, motorCount());
    nextConfig.fc_orientation = orientationMatrixOrIdentity(state.orientationMatrix).map(round4);
    nextConfig.fc_gyro_bias = readNumGrid(form, 'fc_gyro_bias', 1, 3);
    nextConfig.fc_accel_bias = readNumGrid(form, 'fc_accel_bias', 1, 3);
    nextConfig.fc_accel_scale = readNumGrid(form, 'fc_accel_scale', 1, 3);
    if (nextConfig.fc_gyro_bias.some((value) => Math.abs(value) > 100)) {
      throw new Error(t('error.gyroBiasRange'));
    }
    if (nextConfig.fc_accel_bias.some((value) => Math.abs(value) > 20)) {
      throw new Error(t('error.accelBiasRange'));
    }
    if (nextConfig.fc_accel_scale.some((value) => value <= 0.5 || value >= 1.5)) {
      throw new Error(t('error.accelScaleRange'));
    }
    delete nextConfig.pwm;
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(nextConfig)});
    if (state.profileDraft) {
      state.profileDraft.flight = null;
      if (!state.profileDraft.pwm) state.profileDraft = null;
    }
    markProfileSectionApplied('flight');
    state.extraMixerRows = 0;
    await loadDevice();
  }, t('message.flightSaved'));
}

function beginnerSensitivityLevel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 5;
  return Math.max(1, Math.min(10, Math.round(numeric / 0.2)));
}

function beginnerSensitivityGain(level) {
  return Number((Math.max(1, Math.min(10, Number(level) || 5)) * 0.2).toFixed(1));
}

function readBeginnerRatePid(form) {
  const ratePid = [...flightConfigValue('fc_rate_pid', Array(12).fill(0))];
  [0, 1, 2].forEach((axis) => {
    const level = intOrDefault(form.elements[`beginner-sensitivity-${axis}`]?.value, 5);
    ratePid[axis * 4] = beginnerSensitivityGain(level);
  });
  return ratePid;
}

async function saveBeginnerFlightOrientation(form) {
  const nextConfig = {
    ...config(),
    fc_orientation: orientationMatrixOrIdentity(state.orientationMatrix).map(round4),
    fc_rate_pid: readBeginnerRatePid(form),
  };
  await runBusy(async () => {
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(nextConfig)});
    markProfileSectionApplied('flight');
    await loadDevice();
  }, t('message.flightSaved'));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function vectorLength(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalizeVector(v) {
  const length = vectorLength(v);
  if (!Number.isFinite(length) || length < 0.1) {
    throw new Error(t('error.sampleInvalid'));
  }
  return v.map((value) => value / length);
}

function dotVector(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossVector(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function nearestCardinalAxis(vector) {
  const absolute = vector.map(Math.abs);
  const axis = absolute.indexOf(Math.max(...absolute));
  const result = [0, 0, 0];
  result[axis] = vector[axis] >= 0 ? 1 : -1;
  return result;
}

function multiplyMatrix3(left, right) {
  const result = Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let index = 0; index < 3; index += 1) {
        result[row * 3 + column] += left[row * 3 + index] * right[index * 3 + column];
      }
    }
  }
  return result;
}

async function sampleRawImu(sensor, sampleCount, delayMs, frame = 'raw') {
  const samples = [];
  let transformedFrameAvailable = false;
  for (let i = 0; i < sampleCount; i += 1) {
    const status = await apiFetch('/status.json', {timeout: 2000});
    const imu = status?.imu || {};
    if (imu['tf-frame'] === 'aircraft') transformedFrameAvailable = true;
    const key = `${frame === 'tf' ? 'tf-' : ''}${sensor === 'gyro' ? 'gyro-dps' : 'accel-mps2'}`;
    const value = imu[key];
    const valid = sensor === 'gyro' ? imu['gyro-ready'] : imu['accel-valid'];
    if (valid && value) {
      const x = Number(value.x);
      const y = Number(value.y);
      const z = Number(value.z);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        samples.push([x, y, z]);
      }
    }
    if (i + 1 < sampleCount) await sleep(delayMs);
  }
  if (frame === 'tf' && !transformedFrameAvailable) {
    throw new Error(t('error.tfImuUnavailable'));
  }
  if (samples.length < Math.ceil(sampleCount * 0.75)) {
    throw new Error(t('error.notEnoughImuSamples'));
  }
  const mean = [0, 1, 2].map((axis) => samples.reduce((sum, value) => sum + value[axis], 0) / samples.length);
  const stddev = [0, 1, 2].map((axis) => Math.sqrt(samples.reduce((sum, value) => {
    const delta = value[axis] - mean[axis];
    return sum + delta * delta;
  }, 0) / samples.length));
  const range = [0, 1, 2].map((axis) => {
    const values = samples.map((value) => value[axis]);
    return Math.max(...values) - Math.min(...values);
  });
  return {mean, stddev, range, count: samples.length};
}

const STANDARD_GRAVITY = 9.80665;
const ACCEL_CAL_FACES = [
  {axis: 0, sign: 1, label: 'imuCalibration.faceXPos'},
  {axis: 0, sign: -1, label: 'imuCalibration.faceXNeg'},
  {axis: 1, sign: 1, label: 'imuCalibration.faceYPos'},
  {axis: 1, sign: -1, label: 'imuCalibration.faceYNeg'},
  {axis: 2, sign: 1, label: 'imuCalibration.faceZPos'},
  {axis: 2, sign: -1, label: 'imuCalibration.faceZNeg'},
];
const ORIENTATION_CAL_STEPS = [
  {faceIndex: 4, label: 'orient.topUp'},
  {faceIndex: 0, label: 'orient.noseUp'},
];
const MAX_ORIENTATION_LEVEL_CORRECTION_DEG = 30;
const MAX_ORIENTATION_NOSE_ERROR_DEG = 25;
const MAX_ORIENTATION_POSE_DOT = Math.cos(70 * Math.PI / 180);

function roundedImuVector(values) {
  return values.map((value) => Number(value.toFixed(6)));
}

function calculateAccelCalibration(faces) {
  const bias = [];
  const scale = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const positive = faces[axis * 2].mean[axis];
    const negative = faces[axis * 2 + 1].mean[axis];
    const span = positive - negative;
    const nextScale = (2 * STANDARD_GRAVITY) / span;
    if (!Number.isFinite(nextScale) || nextScale <= 0.5 || nextScale >= 1.5) {
      throw new Error(t('error.accelCalibrationRange'));
    }
    bias.push((positive + negative) / 2);
    scale.push(nextScale);
  }
  return {bias: roundedImuVector(bias), scale: roundedImuVector(scale)};
}

function detectAccelFace(mean) {
  const absolute = mean.map(Math.abs);
  const axis = absolute.indexOf(Math.max(...absolute));
  const sign = mean[axis] >= 0 ? 1 : -1;
  const index = ACCEL_CAL_FACES.findIndex((face) => face.axis === axis && face.sign === sign);
  const crossMagnitude = Math.hypot(...mean.filter((_, candidateAxis) => candidateAxis !== axis));
  if (index < 0 || absolute[axis] < 7.0 || crossMagnitude > 4.5) return -1;
  return index;
}

async function captureCurrentAccelFace() {
  if (state.busy || state.imuCalibration.busy || state.orientationCal.busy) return;
  state.imuCalibration.busy = 'accel-detect';
  render();
  try {
    // Firmware exposes tf-accel-mps2 after board-orientation TF but before
    // bias/scale calibration, which is exactly the frame needed here.
    const sample = await sampleRawImu('accel', 32, 35, 'tf');
    const magnitude = vectorLength(sample.mean);
    if (Math.max(...sample.stddev) > 0.35 || Math.max(...sample.range) > 1.5) {
      throw new Error(t('error.imuMoved'));
    }
    if (magnitude < 7.5 || magnitude > 12.2) {
      throw new Error(t('error.accelMagnitude'));
    }
    const index = detectAccelFace(sample.mean);
    if (index < 0) throw new Error(t('error.accelFaceUnclear'));
    const face = ACCEL_CAL_FACES[index];
    if (state.imuCalibration.accelFaces[index]) {
      throw new Error(t('error.accelFaceDuplicate', {face: t(face.label)}));
    }
    state.imuCalibration.accelFaces[index] = sample;
    if (state.imuCalibration.accelFaces.every(Boolean)) {
      const result = calculateAccelCalibration(state.imuCalibration.accelFaces);
      state.imuCalibration.accelBias = result.bias;
      state.imuCalibration.accelScale = result.scale;
      state.message = {type: 'ok', text: t('imuCalibration.accelComplete')};
    } else {
      state.message = {type: 'ok', text: t('imuCalibration.faceCaptured', {face: t(face.label)})};
    }
  } catch (error) {
    state.message = {type: 'error', text: error.message || String(error)};
  } finally {
    state.imuCalibration.busy = '';
    render();
  }
}

async function calibrateGyro() {
  if (state.busy || state.imuCalibration.busy || state.orientationCal.busy) return;
  state.imuCalibration.busy = 'gyro';
  render();
  try {
    const sample = await sampleRawImu('gyro', 64, 30, 'tf');
    if (Math.max(...sample.stddev) > 0.8 || Math.max(...sample.range) > 4.0) {
      throw new Error(t('error.gyroMoved'));
    }
    if (sample.mean.some((value) => Math.abs(value) > 100)) {
      throw new Error(t('error.gyroBiasRange'));
    }
    state.imuCalibration.gyroBias = roundedImuVector(sample.mean);
    state.message = {type: 'ok', text: t('imuCalibration.gyroComplete')};
  } catch (error) {
    state.message = {type: 'error', text: error.message || String(error)};
  } finally {
    state.imuCalibration.busy = '';
    render();
  }
}

function resetAccelCalibration() {
  if (state.imuCalibration.busy) return;
  state.imuCalibration.accelFaces = Array(6).fill(null);
  state.imuCalibration.accelBias = null;
  state.imuCalibration.accelScale = null;
  state.message = null;
  render();
}

function determinantMatrix3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function inverseTransposeMatrix3(m) {
  const determinant = determinantMatrix3(m);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.000001) {
    throw new Error(t('error.orientationFit'));
  }
  return [
    (m[4] * m[8] - m[5] * m[7]) / determinant,
    (m[5] * m[6] - m[3] * m[8]) / determinant,
    (m[3] * m[7] - m[4] * m[6]) / determinant,
    (m[2] * m[7] - m[1] * m[8]) / determinant,
    (m[0] * m[8] - m[2] * m[6]) / determinant,
    (m[1] * m[6] - m[0] * m[7]) / determinant,
    (m[1] * m[5] - m[2] * m[4]) / determinant,
    (m[2] * m[3] - m[0] * m[5]) / determinant,
    (m[0] * m[4] - m[1] * m[3]) / determinant,
  ];
}

function nearestRotationMatrix3(candidate) {
  if (determinantMatrix3(candidate) <= 0.05) throw new Error(t('error.orientationFit'));
  let matrix = candidate.map(Number);
  // Newton polar decomposition removes floating-point drift and projects onto SO(3).
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const inverseTranspose = inverseTransposeMatrix3(matrix);
    matrix = matrix.map((value, index) => (value + inverseTranspose[index]) / 2);
  }
  if (determinantMatrix3(matrix) < 0.999) throw new Error(t('error.orientationFit'));
  return matrix.map(round4);
}

function rotateVector3(matrix, vector) {
  return [
    dotVector(matrix.slice(0, 3), vector),
    dotVector(matrix.slice(3, 6), vector),
    dotVector(matrix.slice(6, 9), vector),
  ];
}

function calculateOrientationMatrix(samples) {
  if (!samples.every(Boolean)) throw new Error(t('error.orientationIncomplete'));
  const levelRaw = normalizeVector(samples[0].mean);
  const noseRaw = normalizeVector(samples[1].mean);
  if (Math.abs(dotVector(levelRaw, noseRaw)) > MAX_ORIENTATION_POSE_DOT) {
    throw new Error(t('error.orientationPosesNotPerpendicular'));
  }

  // First identify the nearest 90-degree sensor-to-aircraft axis mapping.
  const rowZ = nearestCardinalAxis(levelRaw);
  const rowX = nearestCardinalAxis(noseRaw);
  if (Math.abs(dotVector(rowX, rowZ)) > 0) {
    throw new Error(t('error.orientationSameAxis'));
  }
  const rowY = crossVector(rowZ, rowX);
  const coarseMatrix = [...rowX, ...rowY, ...rowZ];

  // The first pose is also the horizon reference. Preserve the snapped yaw,
  // then add continuous roll/pitch so its gravity vector maps exactly to +Z.
  const coarseLevel = normalizeVector(rotateVector3(coarseMatrix, levelRaw));
  const roll = Math.atan2(coarseLevel[1], coarseLevel[2]);
  const pitch = Math.atan2(-coarseLevel[0], Math.hypot(coarseLevel[1], coarseLevel[2]));
  const rollDeg = deg(roll);
  const pitchDeg = deg(pitch);
  if (Math.abs(rollDeg) > MAX_ORIENTATION_LEVEL_CORRECTION_DEG
      || Math.abs(pitchDeg) > MAX_ORIENTATION_LEVEL_CORRECTION_DEG) {
    throw new Error(t('error.orientationLevelTiltTooLarge'));
  }

  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rollCorrection = [1, 0, 0, 0, cr, -sr, 0, sr, cr];
  const pitchCorrection = [cp, 0, sp, 0, 1, 0, -sp, 0, cp];
  const levelCorrection = multiplyMatrix3(pitchCorrection, rollCorrection);
  const matrix = nearestRotationMatrix3(multiplyMatrix3(levelCorrection, coarseMatrix));

  const transformedNose = normalizeVector(rotateVector3(matrix, noseRaw));
  const noseErrorDeg = deg(Math.acos(clamp(transformedNose[0], -1, 1)));
  if (noseErrorDeg > MAX_ORIENTATION_NOSE_ERROR_DEG) {
    throw new Error(t('error.orientationNoseMismatch'));
  }
  return {
    matrix,
    levelCorrectionDeg: [round4(rollDeg), round4(pitchDeg)],
  };
}

async function captureOrientationFace() {
  if (state.busy || state.orientationCal.busy || state.imuCalibration.busy) return;
  const index = state.orientationCal.samples.findIndex((sample) => !sample);
  if (index < 0) return;
  if (!state.orientationCal.samples.some(Boolean)) {
    state.orientationCal.baseMatrix = orientationMatrixOrIdentity(state.orientationMatrix).slice();
  }
  state.orientationCal.busy = true;
  render();
  try {
    const sample = await sampleRawImu('accel', 32, 35, 'raw');
    const magnitude = vectorLength(sample.mean);
    if (Math.max(...sample.stddev) > 0.35 || Math.max(...sample.range) > 1.5) {
      throw new Error(t('error.imuMoved'));
    }
    if (magnitude < 7.5 || magnitude > 12.2) throw new Error(t('error.accelMagnitude'));
    state.orientationCal.samples[index] = sample;
    if (state.orientationCal.samples.every(Boolean)) {
      const result = calculateOrientationMatrix(state.orientationCal.samples);
      state.orientationMatrix = result.matrix;
      state.orientationCal.levelCorrectionDeg = result.levelCorrectionDeg;
      setMessage('ok', t('orient.complete', {
        roll: result.levelCorrectionDeg[0].toFixed(1),
        pitch: result.levelCorrectionDeg[1].toFixed(1),
      }));
    } else {
      setMessage('ok', t('orient.topCaptured'));
    }
  } catch (error) {
    setMessage('error', error.message || String(error));
  } finally {
    state.orientationCal.busy = false;
    render();
  }
}

function resetOrientationCalibration() {
  if (state.orientationCal.busy || state.imuCalibration.busy) return;
  if (state.orientationCal.baseMatrix) state.orientationMatrix = state.orientationCal.baseMatrix.slice();
  state.orientationCal.samples = Array(2).fill(null);
  state.orientationCal.levelCorrectionDeg = null;
  state.orientationCal.baseMatrix = null;
  state.message = null;
  render();
}

async function saveHardwareJson(event) {
  event.preventDefault();
  await runBusy(async () => {
    const next = JSON.parse(event.currentTarget.hardware_json.value);
    next.customised = true;
    await apiFetch('/hardware.json', {method: 'POST', body: JSON.stringify(next)});
    await loadDevice();
  }, t('message.hardwareSaved'));
}

async function scanNetworks() {
  await runBusy(async () => {
    const result = await fetch(apiUrl('/networks.json'));
    state.networks = result.status === 204 ? [] : await result.json();
  }, state.networks.length ? t('message.networkScanComplete') : t('message.scanStarted'));
}

async function saveHomeNetwork(event) {
  event.preventDefault();
  const data = readForm(event.currentTarget);
  const form = new FormData();
  form.set('network', data.network || '');
  form.set('password', data.password || '');
  await runBusy(async () => {
    await apiFetch('/sethome?save', {method: 'POST', body: form});
  }, t('message.homeNetworkSaved'));
}

async function postPlain(path, successText) {
  if (state.busy) return;
  await runBusy(async () => {
    await apiFetch(path, {method: 'POST', body: new FormData()});
  }, successText);
}

async function rebootDevice() {
  if (state.busy) return;
  await runBusy(async () => {
    // Older receiver firmware labels its plain-text reboot acknowledgement as
    // JSON. xhrRequest deliberately tolerates that legacy response.
    await xhrRequest('/reboot', {method: 'POST', body: new FormData(), timeout: 3000});
    // Keep the action locked while the old device instance is shutting down.
    // This prevents repeated software resets if the user clicks again before
    // the receiver has had a chance to boot and resume ELRS reception.
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }, t('message.rebootRequested'));
}

async function uploadFirmwareFile(file) {
  await runBusy(async () => {
    state.uploadProgress = {loaded: 0, total: file.size, phase: t('update.phase.verifying')};
    render();
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    if ((state.target?.target || '').toUpperCase().includes('ESP32')) {
      validateUnifiedEsp32Firmware(fileBytes);
    }
    const fileMd5 = md5Hex(fileBytes);
    const form = new FormData();
    form.set('update[]', file, file.name);
    state.uploadProgress = {loaded: 0, total: file.size, phase: t('update.phase.uploading')};
    render();
    const result = await xhrRequest('/update', {
      method: 'POST',
      body: form,
      headers: {
        'X-FileSize': String(file.size),
        'X-File-MD5': fileMd5,
      },
      timeout: 90000,
      onUploadProgress: (progressEvent) => {
        state.uploadProgress = {
          loaded: progressEvent.loaded,
          total: progressEvent.lengthComputable ? progressEvent.total : file.size,
          phase: progressEvent.loaded >= file.size ? t('update.phase.finalizing') : t('update.phase.uploading'),
        };
        render();
      },
    });
    state.uploadResult = result;
    if (result.status !== 'ok') {
      throw new Error(result.msg || t('update.failed', {status: result.status || 'unknown'}));
    }
    state.uploadProgress = {
      loaded: file.size,
      total: file.size,
      phase: t('update.phase.rebooting'),
    };
  }, t('message.uploadFinished'));
  state.uploadProgress = null;
  render();
}

async function uploadFirmware(event) {
  event.preventDefault();
  const file = event.currentTarget.firmware.files[0];
  if (!file) {
    setMessage('error', t('message.selectFirmware'));
    return;
  }
  await uploadFirmwareFile(file);
}

async function flashDownloadedFirmware() {
  if (!state.target || state.firmwareUpdate.status !== 'downloaded') return;
  try {
    const bytes = await tauriInvoke('load_downloaded_firmware');
    const file = new File([bytes], state.firmwareUpdate.filename, {type: 'application/octet-stream'});
    await uploadFirmwareFile(file);
  } catch (error) {
    setMessage('error', String(error));
  }
}

async function forceUpdate(action) {
  const form = new FormData();
  form.set('action', action);
  await runBusy(async () => {
    state.uploadResult = await xhrRequest('/forceupdate', {method: 'POST', body: form, timeout: 90000});
  }, action === 'confirm' ? t('message.forceConfirmed') : t('message.forceCancelled'));
}

function isTauriApp() {
  return Boolean(window.__TAURI_INTERNALS__);
}

async function checkAppUpdate() {
  if (!isTauriApp()) {
    state.appUpdate.status = 'unsupported';
    render();
    return;
  }

  state.appUpdate = {...state.appUpdate, status: 'checking', error: '', downloaded: 0, total: 0};
  render();
  try {
    const result = await tauriInvoke('check_app_update', {source: state.updateSource});
    const update = result.update;
    state.appUpdate = {
      status: update ? 'available' : 'current',
      currentVersion: result.currentVersion,
      version: update?.version || '',
      notes: update?.notes || '',
      downloaded: 0,
      total: 0,
      error: '',
    };
  } catch (error) {
    state.appUpdate = {...state.appUpdate, status: 'error', error: String(error)};
  }
  render();
}

async function installAppUpdate() {
  if (!['available', 'permission'].includes(state.appUpdate.status)) return;

  state.appUpdate = {...state.appUpdate, status: 'downloading', downloaded: 0, total: 0, error: ''};
  render();
  try {
    let downloaded = 0;
    let total = 0;
    const {invoke, Channel} = await import('@tauri-apps/api/core');
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
      if (event.event === 'Started') total = event.data.contentLength || 0;
      if (event.event === 'Progress') downloaded += event.data.chunkLength;
      state.appUpdate = {...state.appUpdate, downloaded, total};
      render();
    };
    const result = await invoke('install_app_update', {onEvent});
    if (result?.permissionRequired) {
      state.appUpdate = {...state.appUpdate, status: 'permission', downloaded, total};
      render();
      return;
    }
    if (result?.installerLaunched) {
      state.appUpdate = {...state.appUpdate, status: 'installing', downloaded, total};
      render();
      return;
    }
    state.appUpdate = {...state.appUpdate, status: 'installed', downloaded, total};
    render();
    const {relaunch} = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (error) {
    state.appUpdate = {...state.appUpdate, status: 'error', error: String(error)};
    render();
  }
}

async function checkFirmwareUpdate() {
  if (!isTauriApp()) {
    state.firmwareUpdate = {...state.firmwareUpdate, status: 'unsupported'};
    render();
    return;
  }
  state.firmwareUpdate = {...state.firmwareUpdate, status: 'checking', latestVersion: '', notes: '', error: '', path: '', downloaded: 0, total: 0};
  render();
  try {
    const result = await tauriInvoke('check_firmware_update', {
      source: state.updateSource,
      device: state.target ? {
        productName: state.target.product_name || '',
        target: state.target.target || '',
        version: state.target.version || '',
      } : null,
    });
    state.firmwareUpdate = {
      status: result.update ? (state.target ? 'available' : 'availableUnconnected') : 'current',
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
      notes: result.notes || '',
      productName: result.update?.productName || state.target?.product_name || '',
      target: result.update?.target || state.target?.target || '',
      filename: result.update?.filename || '',
      downloaded: 0,
      total: result.update?.size || 0,
      path: '',
      error: '',
    };
  } catch (error) {
    state.firmwareUpdate = {...state.firmwareUpdate, status: 'error', error: String(error)};
  }
  render();
}

async function downloadFirmwareUpdate() {
  if (!['available', 'availableUnconnected'].includes(state.firmwareUpdate.status)) return;

  let destinationPath;
  try {
    const {save} = await import('@tauri-apps/plugin-dialog');
    destinationPath = await save({
      defaultPath: state.firmwareUpdate.filename || 'firmware.bin',
      filters: [{name: t('status.firmware'), extensions: ['bin']}],
    });
  } catch (error) {
    state.firmwareUpdate = {...state.firmwareUpdate, status: 'error', error: String(error)};
    render();
    return;
  }
  if (!destinationPath) return;

  state.firmwareUpdate = {...state.firmwareUpdate, status: 'downloading', downloaded: 0, error: '', path: ''};
  render();
  try {
    let downloaded = 0;
    let total = state.firmwareUpdate.total;
    const {invoke, Channel} = await import('@tauri-apps/api/core');
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
      if (event.event === 'Started') total = event.data.contentLength || total;
      if (event.event === 'Progress') downloaded += event.data.chunkLength;
      state.firmwareUpdate = {...state.firmwareUpdate, downloaded, total};
      render();
    };
    const result = await invoke('download_firmware_update', {destinationPath, onEvent});
    if (destinationPath.startsWith('content://')) {
      const [{writeFile}, bytes] = await Promise.all([
        import('@tauri-apps/plugin-fs'),
        invoke('load_downloaded_firmware'),
      ]);
      await writeFile(destinationPath, new Uint8Array(bytes));
      result.path = destinationPath;
      result.filename = state.firmwareUpdate.filename || result.filename;
    }
    state.firmwareUpdate = {
      ...state.firmwareUpdate,
      status: 'downloaded',
      downloaded: total || downloaded,
      total: total || downloaded,
      filename: result.filename,
      path: result.path,
      productName: result.productName || state.firmwareUpdate.productName,
      target: result.target || state.firmwareUpdate.target,
      latestVersion: result.version || state.firmwareUpdate.latestVersion,
      compatible: state.target
        ? (result.target || state.firmwareUpdate.target).trim().toLowerCase()
          === (state.target.target || '').trim().toLowerCase()
        : null,
    };
  } catch (error) {
    state.firmwareUpdate = {...state.firmwareUpdate, status: 'error', error: String(error)};
  }
  render();
}

async function downloadCurrentFirmware() {
  try {
    const blob = await apiFetchBlob('/firmware.bin');
    const path = await saveBlob(blob, 'firmware.bin', [{name: t('status.firmware'), extensions: ['bin']}]);
    if (path) setMessage('ok', t('message.fileSaved', {path}));
  } catch (error) {
    setMessage('error', t('error.saveFile', {error: String(error)}));
  }
}

async function restoreDownloadedFirmware() {
  if (!isTauriApp() || state.firmwareUpdate.path) return;
  try {
    const result = await tauriInvoke('get_downloaded_firmware');
    if (!result) return;
    state.firmwareUpdate = {
      ...state.firmwareUpdate,
      status: 'downloaded',
      latestVersion: result.version || '',
      productName: result.productName || '',
      target: result.target || '',
      filename: result.filename || '',
      downloaded: result.size || 0,
      total: result.size || 0,
      path: result.path || '',
      compatible: null,
      error: '',
    };
    render();
  } catch {
    // A missing/stale in-memory download must not prevent device connection.
  }
}

async function tauriInvoke(command, args = {}) {
  const api = await import('@tauri-apps/api/core');
  return api.invoke(command, args);
}

function formatDebugValue(value, digits = 2, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : t('value.waiting');
}

function createFallbackAircraft() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({color: 0xd8dee6, metalness: 0.15, roughness: 0.55});
  const accent = new THREE.MeshStandardMaterial({color: 0x1f7a6d, metalness: 0.2, roughness: 0.5});
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.4, 24), accent);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.65;
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.26, 0.22), material);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 2.8), material);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.9), accent);
  tail.position.x = -0.9;
  tail.position.y = 0.12;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.65, 0.05), accent);
  fin.position.x = -0.92;
  fin.position.y = 0.35;
  group.add(body, nose, wing, tail, fin);
  return group;
}

function disposeDebugAircraftView() {
  if (!debugAircraftView) return;
  window.removeEventListener('resize', debugAircraftView.resize);
  debugAircraftView.renderer?.dispose();
  debugAircraftView = null;
}

function initDebugAircraftView() {
  const canvas = document.getElementById('debug-aircraft-canvas');
  const wrapper = document.getElementById('debug-aircraft-wrapper');
  if (!canvas || !wrapper) {
    disposeDebugAircraftView();
    return;
  }
  if (debugAircraftView?.canvas === canvas) {
    debugAircraftView.resize();
    return;
  }
  disposeDebugAircraftView();

  const renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, preserveDrawingBuffer: true});
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 1.5, 7);
  camera.lookAt(0, 0, 0);

  const modelWrapper = new THREE.Object3D();
  let model = createFallbackAircraft();
  model.scale.set(1.4, 1.4, 1.4);
  modelWrapper.add(model);
  scene.add(modelWrapper);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b2, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(2.5, 4, 3);
  scene.add(keyLight);

  const view = {
    canvas,
    renderer,
    scene,
    camera,
    modelWrapper,
    get model() {
      return model;
    },
    set model(nextModel) {
      modelWrapper.remove(model);
      model = nextModel;
      modelWrapper.add(model);
    },
    resize() {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      updateDebugAircraftAttitude(state.debugSample);
    },
    render() {
      renderer.render(scene, camera);
    },
  };

  debugAircraftView = view;
  window.addEventListener('resize', view.resize);

  new GLTFLoader().load(
    AIRCRAFT_MODEL_URL,
    (gltf) => {
      if (debugAircraftView !== view) return;
      const loadedModel = gltf.scene;
      loadedModel.scale.set(0.5, 0.5, 0.5);
      const box = new THREE.Box3().setFromObject(loadedModel);
      const center = box.getCenter(new THREE.Vector3());
      loadedModel.position.sub(center);
      view.model = loadedModel;
      updateDebugAircraftAttitude(state.debugSample);
    },
    undefined,
    () => {
      view.render();
    },
  );

  view.resize();
}

function updateDebugAircraftAttitude(sample) {
  if (!debugAircraftView?.model || !sample) {
    debugAircraftView?.render();
    return;
  }
  debugAircraftView.model.rotation.x = sample.roll_deg * DEG_TO_RAD;
  debugAircraftView.modelWrapper.rotation.y = sample.yaw_deg * DEG_TO_RAD;
  debugAircraftView.model.rotation.z = sample.pitch_deg * -DEG_TO_RAD;
  debugAircraftView.render();
}

const ORIENTATION_FACE_ATTITUDES = {
  0: {roll: 0, pitch: -90, yaw: 0},
  1: {roll: 0, pitch: 90, yaw: 0},
  2: {roll: 90, pitch: 0, yaw: 0},
  3: {roll: -90, pitch: 0, yaw: 0},
  4: {roll: 0, pitch: 0, yaw: 0},
  5: {roll: 180, pitch: 0, yaw: 0},
};

function currentOrientationFaceIndex() {
  const stepIndex = state.orientationCal.samples.findIndex((sample) => !sample);
  return ORIENTATION_CAL_STEPS[stepIndex >= 0 ? stepIndex : ORIENTATION_CAL_STEPS.length - 1].faceIndex;
}

function disposeOrientationAircraftView() {
  if (!orientationAircraftView) return;
  window.removeEventListener('resize', orientationAircraftView.resize);
  orientationAircraftView.renderer?.dispose();
  orientationAircraftView = null;
}

function updateOrientationAircraftPose() {
  if (!orientationAircraftView?.model) return;
  const attitude = ORIENTATION_FACE_ATTITUDES[currentOrientationFaceIndex()];
  orientationAircraftView.model.rotation.x = attitude.roll * DEG_TO_RAD;
  orientationAircraftView.model.rotation.z = attitude.pitch * -DEG_TO_RAD;
  orientationAircraftView.modelWrapper.rotation.y = attitude.yaw * DEG_TO_RAD;
  orientationAircraftView.render();
}

function initOrientationAircraftView() {
  const canvas = document.getElementById('orientation-aircraft-canvas');
  const wrapper = document.getElementById('orientation-aircraft-wrapper');
  if (!canvas || !wrapper) {
    disposeOrientationAircraftView();
    return;
  }
  if (orientationAircraftView?.canvas === canvas) {
    orientationAircraftView.resize();
    return;
  }
  disposeOrientationAircraftView();

  const renderer = new THREE.WebGLRenderer({canvas, alpha: true, antialias: true, preserveDrawingBuffer: true});
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 1.5, 7);
  camera.lookAt(0, 0, 0);
  const modelWrapper = new THREE.Object3D();
  let model = createFallbackAircraft();
  model.scale.set(1.4, 1.4, 1.4);
  modelWrapper.add(model);
  scene.add(modelWrapper);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b2, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(2.5, 4, 3);
  scene.add(keyLight);

  const view = {
    canvas,
    renderer,
    scene,
    camera,
    modelWrapper,
    get model() { return model; },
    set model(nextModel) {
      modelWrapper.remove(model);
      model = nextModel;
      modelWrapper.add(model);
    },
    resize() {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      updateOrientationAircraftPose();
    },
    render() { renderer.render(scene, camera); },
  };
  orientationAircraftView = view;
  window.addEventListener('resize', view.resize);

  new GLTFLoader().load(
    AIRCRAFT_MODEL_URL,
    (gltf) => {
      if (orientationAircraftView !== view) return;
      const loadedModel = gltf.scene;
      loadedModel.scale.set(0.5, 0.5, 0.5);
      const box = new THREE.Box3().setFromObject(loadedModel);
      const center = box.getCenter(new THREE.Vector3());
      loadedModel.position.sub(center);
      view.model = loadedModel;
      updateOrientationAircraftPose();
    },
    undefined,
    () => view.render(),
  );
  view.resize();
}

function profilePwmOutputs() {
  const form = document.querySelector('#pwm-form');
  const limits = pwmOutputLimits();
  return pwmEntries().map((entry, index) => {
    if (!form) {
      return {
        ...decodePwmConfig(entry.config),
        min: limits[index][0],
        center: limits[index][1],
        max: limits[index][2],
      };
    }
    return {
      mode: intOrDefault(form.elements[`pwm-mode-${index}`]?.value, 0),
      inputChannel: intOrDefault(form.elements[`pwm-input-${index}`]?.value, 0),
      inverted: Boolean(form.elements[`pwm-invert-${index}`]?.checked),
      signalPolarityInverted: Boolean(form.elements[`pwm-polarity-${index}`]?.checked),
      narrow: Boolean(form.elements[`pwm-narrow-${index}`]?.checked),
      failsafeMode: intOrDefault(form.elements[`pwm-failsafe-mode-${index}`]?.value, 0),
      failsafe: intOrDefault(form.elements[`pwm-failsafe-${index}`]?.value, 1500),
      mixerMode: intOrDefault(form.elements[`pwm-source-${index}`]?.value, 0) === 1,
      min: intOrDefault(form.elements[`pwm-limit-min-${index}`]?.value, limits[index][0]),
      center: intOrDefault(form.elements[`pwm-limit-center-${index}`]?.value, limits[index][1]),
      max: intOrDefault(form.elements[`pwm-limit-max-${index}`]?.value, limits[index][2]),
    };
  });
}

function profileFlightConfig() {
  const form = document.querySelector('#flight-form');
  if (!form) {
    return {
      modeConditions: flightConfigValue('fc_mode_conditions', {}),
      arm: {
        enabled: flightConfigValue('fc_arm_enabled', false),
        channel: flightConfigValue('fc_arm_channel', 5),
        range: flightConfigValue('fc_arm_range', [1700, 2100]),
      },
      ratePid: flightConfigValue('fc_rate_pid', []),
      anglePid: flightConfigValue('fc_angle_pid', []),
      angleRateLimitsDps: flightConfigValue('fc_angle_rate_limits_dps', [100, 100]),
      dtermLpfHz: flightConfigValue('fc_dterm_lpf_hz', 20),
      gyroLpfHz: flightConfigValue('fc_gyro_lpf_hz', 30),
      gyroBiasMode: flightConfigValue('fc_gyro_bias_mode', 0),
      mixer: flightConfigValue('fc_mixer', []),
      mixerServos: flightConfigValue('fc_mixer_servos', []),
      orientation: orientationMatrixOrIdentity(state.orientationMatrix).map(round4),
    };
  }

  const modeConditions = {};
  ['rate', 'angle'].forEach((mode) => {
    if (!form[`fc_${mode}_enabled`].checked) return;
    modeConditions[mode] = [
      intOrDefault(form[`fc_${mode}_channel`].value, 6),
      intOrDefault(form[`fc_${mode}_start`].value, 0),
      intOrDefault(form[`fc_${mode}_end`].value, 0),
    ];
  });
  return {
    modeConditions,
    arm: {
      enabled: form.fc_arm_enabled.checked,
      channel: intOrDefault(form.fc_arm_channel.value, 5),
      range: [
        intOrDefault(form.fc_arm_start.value, 0),
        intOrDefault(form.fc_arm_end.value, 0),
      ],
    },
    ratePid: readNumGrid(form, 'fc_rate_pid', 3, 4),
    anglePid: readNumGrid(form, 'fc_angle_pid', 3, 4),
    angleRateLimitsDps: [
      intOrDefault(form.fc_angle_rate_limit_roll_dps.value, 100),
      intOrDefault(form.fc_angle_rate_limit_pitch_dps.value, 100),
    ],
    dtermLpfHz: intOrDefault(form.fc_dterm_lpf_hz.value, 20),
    gyroLpfHz: intOrDefault(form.fc_gyro_lpf_hz.value, 30),
    gyroBiasMode: intOrDefault(form.fc_gyro_bias_mode.value, 0),
    mixer: readNumGrid(form, 'fc_mixer', motorCount(), 4),
    mixerServos: readMixerServos(form, motorCount()),
    orientation: orientationMatrixOrIdentity(state.orientationMatrix).map(round4),
  };
}

function buildProfile() {
  const hasPwm = Boolean(state.profileDraft?.pwm?.length)
    || (Array.isArray(config().pwm) && config().pwm.length > 0);
  const outputs = hasPwm ? profilePwmOutputs() : [];
  const hasFlight = Array.isArray(flightConfigValue('fc_rate_pid', undefined));
  return {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    compatibility: {
      target: state.target?.target || config().target || state.profileCompatibility?.target || '',
      productName: state.target?.product_name || config().product_name || state.profileCompatibility?.productName || '',
      pwmOutputCount: outputs.length,
    },
    pwm: outputs.length ? {
      outputs,
      serial2Protocol: state.profileDraft?.serial1Protocol ?? configValue('serial1-protocol', 0),
    } : null,
    flight: hasFlight ? profileFlightConfig() : null,
  };
}

function profileCanExport() {
  return Boolean(state.profileDraft?.pwm?.length)
    || (Array.isArray(config().pwm) && config().pwm.length > 0)
    || Array.isArray(flightConfigValue('fc_rate_pid', undefined));
}

async function saveBlob(blob, fileName, filters = []) {
  if (isTauriApp()) {
    const [{save}, {writeFile}] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({defaultPath: fileName, filters});
    if (!path) return null;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const pickerOptions = {suggestedName: fileName};
      if (filters.length) {
        pickerOptions.types = filters.map((filter) => ({
          description: filter.name,
          accept: {[blob.type || 'application/octet-stream']: filter.extensions.map((extension) => `.${extension}`)},
        }));
      }
      const handle = await window.showSaveFilePicker(pickerOptions);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

async function exportProfile() {
  const profile = buildProfile();
  const product = profile.compatibility.productName || profile.compatibility.target || 'receiver';
  const safeName = product.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'receiver';
  const blob = new Blob([JSON.stringify(profile, null, 2)], {type: 'application/json'});
  try {
    const path = await saveBlob(blob, `${safeName}-profile.json`, [{name: 'JSON', extensions: ['json']}]);
    if (path) setMessage('ok', t('message.profileExported'));
  } catch (error) {
    setMessage('error', t('error.saveFile', {error: String(error)}));
  }
}

function requireProfileNumber(value, label, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(t('error.profileValue', {label}));
  }
  return value;
}

function requireProfileArray(value, label, length, min, max, integer = false) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(t('error.profileArrayLength', {label, length}));
  }
  return value.map((item, index) => requireProfileNumber(item, `${label}[${index}]`, min, max, integer));
}

function validateProfileRange(value, label) {
  const range = requireProfileArray(value, label, 2, 900, 2100, true);
  if (range[0] >= range[1]) throw new Error(t('error.profileValue', {label}));
  return range;
}

function validateOrientationMatrix(matrix) {
  const row = (index) => matrix.slice(index * 3, index * 3 + 3);
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const rows = [row(0), row(1), row(2)];
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
    - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
    + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
  const orthogonal = rows.every((current, index) =>
    Math.abs(dot(current, current) - 1) < 0.03
    && rows.every((other, otherIndex) => index === otherIndex || Math.abs(dot(current, other)) < 0.03));
  if (!orthogonal || Math.abs(determinant - 1) >= 0.05) throw new Error(t('error.profileOrientation'));
  return matrix;
}

function validateProfile(profile, {deviceAware = Boolean(state.configResponse)} = {}) {
  if (!profile || profile.format !== PROFILE_FORMAT) throw new Error(t('error.profileFormat'));
  if (profile.version !== PROFILE_VERSION) throw new Error(t('error.profileVersion', {version: profile.version}));
  if (!profile.pwm && !profile.flight) throw new Error(t('error.profileEmpty'));

  const draft = {
    pwm: null,
    pwmLimits: null,
    serial1Protocol: null,
    flight: null,
  };
  const warnings = [];
  const currentTarget = state.target?.target || config().target || '';
  if (profile.compatibility?.target && currentTarget && profile.compatibility.target !== currentTarget) {
    warnings.push(t('profile.targetWarning', {source: profile.compatibility.target, target: currentTarget}));
  }

  if (profile.pwm) {
    const deviceEntries = Array.isArray(config().pwm) ? config().pwm : [];
    if (deviceAware && !deviceEntries.length) throw new Error(t('error.profilePwmUnsupported'));
    const maximumOutputs = deviceAware ? deviceEntries.length : 16;
    if (!Array.isArray(profile.pwm.outputs) || profile.pwm.outputs.length < 1 || profile.pwm.outputs.length > maximumOutputs) {
      throw new Error(t('error.profilePwmCount', {source: profile.pwm.outputs?.length ?? 0, target: maximumOutputs}));
    }
    const exclusive = new Set();
    draft.pwmLimits = [];
    draft.pwm = profile.pwm.outputs.map((output, index) => {
      const mode = requireProfileNumber(output?.mode, `PWM ${index + 1} mode`, 0, pwmModes.length - 1, true);
      if (deviceAware && !pwmModeAllowed(Number(deviceEntries[index].features) || 0, mode)) {
        throw new Error(t('error.profilePwmMode', {output: index + 1, mode: pwmModes[mode]}));
      }
      if (mode > 9) {
        if (exclusive.has(mode)) throw new Error(t('error.pwmExclusive', {mode: pwmModes[mode], output: index + 1}));
        exclusive.add(mode);
      }
      const min = requireProfileNumber(output.min ?? 1000, `PWM ${index + 1} min`, 500, 2500, true);
      const center = requireProfileNumber(output.center ?? 1500, `PWM ${index + 1} center`, 500, 2500, true);
      const max = requireProfileNumber(output.max ?? 2000, `PWM ${index + 1} max`, 500, 2500, true);
      if (min >= center || center >= max) {
        throw new Error(t('error.profileValue', {label: `PWM ${index + 1} limits`}));
      }
      draft.pwmLimits.push([min, center, max]);
      return encodePwmConfig({
        mode,
        inputChannel: requireProfileNumber(output.inputChannel, `PWM ${index + 1} inputChannel`, 0, 15, true),
        inverted: Boolean(output.inverted),
        signalPolarityInverted: Boolean(output.signalPolarityInverted),
        narrow: Boolean(output.narrow),
        failsafeMode: requireProfileNumber(output.failsafeMode, `PWM ${index + 1} failsafeMode`, 0, 2, true),
        failsafe: requireProfileNumber(output.failsafe, `PWM ${index + 1} failsafe`, 988, 2011, true),
        mixerMode: Boolean(output.mixerMode),
      });
    });
    draft.serial1Protocol = requireProfileNumber(profile.pwm.serial2Protocol ?? 0, 'serial2Protocol', 0, serial1Protocols.length - 1, true);
    if (deviceAware && draft.pwm.length < deviceEntries.length) {
      warnings.push(t('profile.pwmPartialWarning', {source: draft.pwm.length, target: deviceEntries.length}));
    }
  }

  if (profile.flight) {
    if (deviceAware && !Array.isArray(config().fc_rate_pid)) throw new Error(t('error.profileFlightUnsupported'));
    const mixer = profile.flight.mixer;
    if (!Array.isArray(mixer) || mixer.length > 32 || mixer.length % 4 !== 0) {
      throw new Error(t('error.profileMixerLength'));
    }
    mixer.forEach((value, index) => requireProfileNumber(value, `mixer[${index}]`, -1000, 1000));
    const mixerOutputCount = mixer.length / 4;
    const mixerServos = profile.flight.mixerServos ?? Array(mixerOutputCount).fill(false);
    if (!Array.isArray(mixerServos) || mixerServos.length > mixerOutputCount) {
      throw new Error(t('error.profileMixerServosLength'));
    }
    const modeConditions = {};
    for (const mode of ['rate', 'angle']) {
      const condition = profile.flight.modeConditions?.[mode];
      if (!condition) continue;
      const values = requireProfileArray(condition, `${mode} condition`, 3, 0, 2100, true);
      requireProfileNumber(values[0], `${mode} channel`, 5, 16, true);
      validateProfileRange(values.slice(1), `${mode} range`);
      modeConditions[mode] = values;
    }
    const arm = profile.flight.arm || {};
    const dtermLpfHz = requireProfileNumber(profile.flight.dtermLpfHz ?? 20, 'D-term LPF', 0, 100, true);
    if (dtermLpfHz > 0 && dtermLpfHz < 5) {
      throw new Error(t('error.invalidDtermLpf'));
    }
    const gyroLpfHz = requireProfileNumber(profile.flight.gyroLpfHz ?? 30, 'Gyro LPF', 0, 100, true);
    if (gyroLpfHz > 0 && gyroLpfHz < 5) {
      throw new Error(t('error.invalidGyroLpf'));
    }
    const angleRateLimitsDps = requireProfileArray(
      profile.flight.angleRateLimitsDps ?? [100, 100],
      'ANGLE rate limits',
      2,
      1,
      1000,
      true,
    );
    const orientation = validateOrientationMatrix(
      requireProfileArray(profile.flight.orientation, 'orientation', 9, -1.1, 1.1),
    );
    draft.flight = {
      fc_mode_conditions: modeConditions,
      fc_arm_enabled: Boolean(arm.enabled),
      fc_arm_channel: requireProfileNumber(arm.channel ?? 5, 'ARM channel', 5, 16, true),
      fc_arm_range: validateProfileRange(arm.range, 'ARM range'),
      fc_rate_pid: requireProfileArray(profile.flight.ratePid, 'Rate PID', 12, -327.68, 327.67),
      fc_angle_pid: requireProfileArray(profile.flight.anglePid, 'Angle PID', 12, -327.68, 327.67),
      fc_angle_rate_limits_dps: angleRateLimitsDps,
      fc_dterm_lpf_hz: dtermLpfHz,
      fc_gyro_lpf_hz: gyroLpfHz,
      fc_gyro_bias_mode: requireProfileNumber(profile.flight.gyroBiasMode ?? 0, 'Gyro bias mode', 0, 1, true),
      fc_mixer: mixer.map(Number),
      fc_mixer_count: mixer.length,
      fc_mixer_servos: Array.from({length: mixerOutputCount}, (_, index) => Boolean(mixerServos[index])),
      fc_orientation: orientation,
    };
  }
  return {draft, warnings};
}

function applyImportedProfile(profile) {
  const {draft, warnings} = validateProfile(profile);
  state.profileDraft = draft;
  state.profileOriginal = structuredClone(profile);
  state.profileCompatibility = structuredClone(profile.compatibility || {});
  state.profileImportError = '';
  state.extraMixerRows = 0;
  if (draft.flight) state.orientationMatrix = orientationMatrixOrIdentity(draft.flight.fc_orientation);
  state.message = {type: 'ok', text: warnings.length
    ? `${t('message.profileImported')} ${warnings.join(' ')}`
    : t('message.profileImported')};
  render();
}

async function importProfileFile(file) {
  if (!file) return;
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch {
    throw new Error(t('error.profileJson'));
  }
  applyImportedProfile(profile);
}

function discardProfileDraft() {
  state.profileDraft = null;
  state.profileOriginal = null;
  state.profileCompatibility = null;
  state.profileImportError = '';
  state.extraMixerRows = 0;
  const orientation = configValue('fc_orientation', []);
  state.orientationMatrix = orientationMatrixOrIdentity(orientation);
  setMessage('ok', t('message.profileDiscarded'));
}

function markProfileSectionApplied(section) {
  if (!state.profileOriginal) return;
  state.profileOriginal[section] = null;
  state.profileImportError = '';
  if (!state.profileOriginal.pwm && !state.profileOriginal.flight) {
    state.profileOriginal = null;
    state.profileCompatibility = null;
  }
}

function communityProfileSummary(profile) {
  return {
    target: profile.compatibility?.target || t('value.unknown'),
    pwmOutputs: Array.isArray(profile.pwm?.outputs) ? profile.pwm.outputs.length : 0,
    motors: Array.isArray(profile.flight?.mixer) ? profile.flight.mixer.length / 4 : 0,
  };
}

function currentCommunityUsageProfile() {
  return {
    flight: {
      mixer: flightConfigValue('fc_mixer', []),
      mixerServos: flightConfigValue('fc_mixer_servos', []),
      arm: {
        enabled: Boolean(flightConfigValue('fc_arm_enabled', false)),
        channel: flightConfigValue('fc_arm_channel', 5),
      },
      modeConditions: flightConfigValue('fc_mode_conditions', {}),
    },
  };
}

function communityUsageInstructions(profile) {
  const flight = profile?.flight;
  if (!flight) return [];

  const mixer = Array.isArray(flight.mixer) ? flight.mixer : [];
  const mixerOutputCount = Math.floor(mixer.length / 4);
  const mixerServos = Array.isArray(flight.mixerServos) ? flight.mixerServos : [];
  const mixerAxes = [
    'community.catalog.mixerThrottle',
    'community.catalog.mixerRoll',
    'community.catalog.mixerPitch',
    'community.catalog.mixerYaw',
  ];
  const outputs = Array.from({length: mixerOutputCount}, (_, index) => index)
    .filter((index) => !mixer.slice(index * 4, index * 4 + 4).every((value) => Number(value) === 0))
    .map((index) => {
      const row = mixer.slice(index * 4, index * 4 + 4);
      const mix = row
        .map((value, axis) => ({value: Number(value), axis}))
        .filter(({value}) => value !== 0)
        .map(({value, axis}) => t('community.catalog.mixerAxis', {
          value: Number((value * 100).toFixed(2)),
          axis: t(mixerAxes[axis]),
        }))
        .join(t('community.catalog.mixerSeparator'));
      return t(
        mixerServos[index] ? 'community.catalog.usageServo' : 'community.catalog.usageMotor',
        {output: index + 1, mix},
      );
    });

  const switches = [];
  if (flight.arm?.enabled && Number.isInteger(Number(flight.arm.channel))) {
    switches.push(t('community.catalog.usageArm', {channel: flight.arm.channel}));
  }
  for (const mode of ['rate', 'angle']) {
    const condition = flight.modeConditions?.[mode];
    const channel = condition?.[0];
    const start = condition?.[1];
    const end = condition?.[2];
    if (Number.isInteger(Number(channel))) {
      switches.push(t('community.catalog.usageSwitch', {
        channel,
        start: Number.isInteger(Number(start)) ? Number(start) : '',
        end: Number.isInteger(Number(end)) ? Number(end) : '',
        mode: mode.toUpperCase(),
      }));
    }
  }

  return [...outputs, ...switches];
}

function validateCommunityProfile(profile) {
  if (!profile || profile.format !== PROFILE_FORMAT) throw new Error(t('error.profileFormat'));
  if (profile.version !== PROFILE_VERSION) throw new Error(t('error.profileVersion', {version: profile.version}));
  if (!profile.pwm && !profile.flight) throw new Error(t('error.profileEmpty'));
  return profile;
}

function openCommunityCatalog() {
  state.communityCatalog.open = true;
  render();
  if (state.communityCatalog.status === 'idle' || state.communityCatalog.status === 'error') {
    void loadCommunityCatalog();
  }
}

function closeCommunityCatalog() {
  state.communityCatalog.open = false;
  state.communityCatalog.busyId = '';
  render();
}

function validateCommunityCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.profiles)) {
    throw new Error(t('error.communityCatalogInvalid'));
  }
  value.profiles.forEach((item) => {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string'
      || typeof item.profileUrl !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) {
      throw new Error(t('error.communityCatalogInvalid'));
    }
  });
  return value;
}

async function loadCommunityCatalog() {
  state.communityCatalog.status = 'loading';
  state.communityCatalog.error = '';
  render();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(PROFILE_CATALOG_API, {
      headers: {Accept: 'application/json'},
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = validateCommunityCatalog(await response.json());
    state.communityCatalog.profiles = catalog.profiles;
    state.communityCatalog.generatedAt = catalog.generatedAt || '';
    state.communityCatalog.status = 'ready';
    state.communityCatalog.usageLoadingById = Object.fromEntries(catalog.profiles.map((item) => [item.id, true]));
    void preloadCommunityUsage(catalog.profiles);
  } catch (error) {
    state.communityCatalog.status = 'error';
    state.communityCatalog.error = error.name === 'AbortError'
      ? t('error.communityCatalogTimeout')
      : (error.message || String(error));
  } finally {
    window.clearTimeout(timeout);
    render();
  }
}

async function preloadCommunityUsage(profiles) {
  await Promise.all(profiles.map(async (item) => {
    try {
      state.communityCatalog.usageById[item.id] = await fetchCommunityProfile(item);
    } catch {
      // Keep the card visible even if an optional usage preload fails.
    } finally {
      delete state.communityCatalog.usageLoadingById[item.id];
      render();
    }
  }));
}

function communityFilteredProfiles() {
  const query = state.communityCatalog.query.trim().toLocaleLowerCase();
  return state.communityCatalog.profiles.filter((item) => {
    if (state.communityCatalog.vehicleType && communityVehicleType(item) !== state.communityCatalog.vehicleType) return false;
    if (!query) return true;
    return [item.title, item.authorName, item.vehicleType, item.target, ...(item.tags || [])]
      .some((value) => String(value || '').toLocaleLowerCase().includes(query));
  });
}

function communityVehicleType(item) {
  return item.vehicleType || (item.tags || []).find((tag) => ['multirotor', 'fixed-wing', 'vtol'].includes(tag)) || '';
}

function communityVehicleTypes() {
  return [...new Set(state.communityCatalog.profiles.map(communityVehicleType).filter(Boolean))].sort();
}

function renderCommunityProfileCards() {
  const profiles = communityFilteredProfiles();
  if (!profiles.length) return `<div class="community-catalog-empty">${t('community.catalog.empty')}</div>`;
  const currentTarget = state.target?.target || config().target || '';
  return profiles.map((item) => {
    const busy = state.communityCatalog.busyId === item.id;
    const compatible = Boolean(currentTarget && item.target && currentTarget === item.target);
    const usage = communityUsageInstructions(state.communityCatalog.usageById[item.id]);
    const usageLoading = Boolean(state.communityCatalog.usageLoadingById[item.id]);
    return `<article class="community-profile-card">
      <div class="community-profile-heading">
        <div><h3>${escapeHtml(item.title)}</h3><span>${escapeHtml(item.authorName || t('value.unknown'))}</span></div>
        ${compatible ? `<span class="community-compatible">${t('community.catalog.compatible')}</span>` : ''}
      </div>
      <div class="community-profile-meta">
        <span>${t('community.catalog.target')}: <strong>${escapeHtml(item.target || t('value.unknown'))}</strong></span>
        <span>${t('community.catalog.pwm')}: <strong>${escapeHtml(item.profileSummary?.pwmOutputCount ?? 0)}</strong></span>
        <span>${t('community.catalog.motors')}: <strong>${escapeHtml(item.profileSummary?.motorCount ?? 0)}</strong></span>
      </div>
      ${(item.tags || []).length ? `<div class="community-tags">${item.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <div class="community-usage">
        <strong>${t('community.catalog.usageHeading')}</strong>
        ${usageLoading ? `<div class="helper">${t('community.catalog.loadingProfile')}</div>` : usage.length ? `<ul>${usage.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : `<div class="helper">${t('community.catalog.usageEmpty')}</div>`}
      </div>
      <div class="actions community-profile-actions">
        <button class="secondary" type="button" data-community-action="download" data-profile-id="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>${t('action.downloadCommunityProfile')}</button>
        <button class="primary" type="button" data-community-action="import" data-profile-id="${escapeHtml(item.id)}" ${busy ? 'disabled' : ''}>${busy ? t('community.catalog.loadingProfile') : t('action.importCommunityProfile')}</button>
      </div>
    </article>`;
  }).join('');
}

function updateCommunityCatalogResults() {
  const list = document.querySelector('#community-catalog-list');
  const count = document.querySelector('#community-catalog-count');
  if (list) list.innerHTML = renderCommunityProfileCards();
  if (count) count.textContent = t('community.catalog.resultCount', {count: communityFilteredProfiles().length});
  wireCommunityProfileActions();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function md5Hex(input) {
  return Array.from(md5(input), (value) => value.toString(16).padStart(2, '0')).join('');
}

function validateUnifiedEsp32Firmware(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0xe9) {
    throw new Error(t('update.invalidHeader'));
  }
  const segmentCount = bytes[1];
  if (segmentCount < 1 || segmentCount > 16) {
    throw new Error(t('update.invalidSegments'));
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 24;
  for (let segment = 0; segment < segmentCount; ++segment) {
    if (position + 8 > bytes.length) throw new Error(t('update.truncatedImage'));
    const segmentSize = view.getUint32(position + 4, true);
    position += 8 + segmentSize;
    if (!Number.isSafeInteger(position) || position > bytes.length) {
      throw new Error(t('update.truncatedImage'));
    }
  }

  const firmwareEnd = ((position + 16) & ~15) + 32;
  const productSize = 128;
  const hardwareOffset = productSize + 16 + 512;
  const hardwareSize = 2048;
  if (firmwareEnd + hardwareOffset + hardwareSize > bytes.length) {
    throw new Error(t('update.missingHardware'));
  }

  const decodeField = (start, length) => {
    const field = bytes.subarray(start, start + length);
    const terminator = field.indexOf(0);
    return new TextDecoder().decode(terminator >= 0 ? field.subarray(0, terminator) : field).trim();
  };
  const product = decodeField(firmwareEnd, productSize);
  if (!product) {
    throw new Error(t('update.missingProduct'));
  }
  // Bare Unified images are intentionally supported by the firmware. They can
  // be flashed first and assigned a hardware target from the WebUI afterwards.
  if (['Unified', 'Unified RX', 'Unified TX'].includes(product)) return;

  try {
    const hardware = JSON.parse(decodeField(firmwareEnd + hardwareOffset, hardwareSize));
    if (!hardware || Array.isArray(hardware) || typeof hardware !== 'object' || Object.keys(hardware).length === 0) {
      throw new Error('empty');
    }
  } catch {
    throw new Error(t('update.invalidHardware'));
  }
}

async function fetchCommunityProfile(item) {
  const catalogUrl = new URL(PROFILE_CATALOG_API);
  const profileUrl = new URL(item.profileUrl, catalogUrl);
  if (profileUrl.origin !== catalogUrl.origin) throw new Error(t('error.communityProfileOrigin'));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(profileUrl, {headers: {Accept: 'application/json'}, signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 512 * 1024) throw new Error(t('error.communityProfileTooLarge'));
    if ((await sha256Hex(raw)).toLowerCase() !== item.sha256.toLowerCase()) {
      throw new Error(t('error.communityProfileIntegrity'));
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(t('error.profileJson'));
    }
    if (envelope.id !== item.id || !envelope.profile) throw new Error(t('error.communityProfileInvalid'));
    return validateCommunityProfile(envelope.profile);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(t('error.communityProfileTimeout'));
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function downloadJson(value, fileName) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {type: 'application/json'});
  return saveBlob(blob, fileName, [{name: 'JSON', extensions: ['json']}]);
}

async function handleCommunityProfileAction(action, id) {
  const item = state.communityCatalog.profiles.find((profile) => profile.id === id);
  if (!item || state.communityCatalog.busyId) return;
  if (action === 'import' && state.profileDraft && !window.confirm(t('community.catalog.replaceDraftConfirm'))) return;
  if (action === 'usage' && state.communityCatalog.usageProfileId === id) {
    state.communityCatalog.usageProfileId = '';
    render();
    return;
  }
  if (action === 'usage' && Object.hasOwn(state.communityCatalog.usageById, id)) {
    state.communityCatalog.usageProfileId = id;
    render();
    return;
  }
  state.communityCatalog.busyId = id;
  state.communityCatalog.error = '';
  render();
  try {
    const profile = await fetchCommunityProfile(item);
    if (action === 'usage') {
      state.communityCatalog.usageById[id] = profile;
      state.communityCatalog.usageProfileId = id;
      state.communityCatalog.busyId = '';
      render();
      return;
    }
    if (action === 'download') {
      const safeName = (item.slug || item.id).replace(/[^a-z0-9._-]+/gi, '-') || 'community-profile';
      const path = await downloadJson(profile, `${safeName}-profile.json`);
      if (!path) {
        state.communityCatalog.busyId = '';
        render();
        return;
      }
      state.communityCatalog.busyId = '';
      state.message = {type: 'ok', text: t('message.communityProfileDownloaded', {title: item.title})};
      render();
      return;
    }
    state.communityCatalog.open = false;
    state.communityCatalog.busyId = '';
    applyImportedProfile(profile);
  } catch (error) {
    state.communityCatalog.busyId = '';
    state.communityCatalog.error = error.message || String(error);
    render();
  }
}

function wireCommunityProfileActions() {
  document.querySelectorAll('[data-community-action]').forEach((button) => {
    button.addEventListener('click', () => {
      void handleCommunityProfileAction(button.dataset.communityAction, button.dataset.profileId);
    });
  });
}

function renderCommunityCatalog() {
  if (!state.communityCatalog.open) return '';
  const loading = state.communityCatalog.status === 'loading';
  const ready = state.communityCatalog.status === 'ready';
  return `<div class="submission-modal" role="dialog" aria-modal="true" aria-labelledby="community-catalog-title">
    <section class="submission-dialog community-catalog-dialog">
      <div class="submission-dialog-heading">
        <div><h2 id="community-catalog-title">${t('community.catalog.heading')}</h2><div class="helper">${t('community.catalog.description')}</div></div>
        <button class="icon-button" type="button" data-action="community-catalog-close" aria-label="${t('action.cancel')}">×</button>
      </div>
      ${state.communityCatalog.error ? `<div class="message error">${escapeHtml(state.communityCatalog.error)}</div>` : ''}
      ${loading ? `<div class="community-catalog-loading">${t('community.catalog.loading')}</div>` : ''}
      ${state.communityCatalog.status === 'error' ? `<div class="actions"><button class="primary" type="button" data-action="community-catalog-refresh">${t('community.catalog.retry')}</button></div>` : ''}
      ${ready ? `<div class="community-catalog-toolbar">
        <input id="community-catalog-search" type="search" value="${escapeHtml(state.communityCatalog.query)}" placeholder="${t('community.catalog.searchPlaceholder')}">
        <select id="community-catalog-vehicle"><option value="">${t('community.catalog.allVehicles')}</option>${communityVehicleTypes().map((vehicle) => `<option value="${escapeHtml(vehicle)}" ${selected(state.communityCatalog.vehicleType, vehicle)}>${escapeHtml(vehicle)}</option>`).join('')}</select>
        <button class="secondary" type="button" data-action="community-catalog-refresh">${t('community.catalog.refresh')}</button>
      </div>
      <div class="community-catalog-summary"><span id="community-catalog-count">${t('community.catalog.resultCount', {count: communityFilteredProfiles().length})}</span>${state.communityCatalog.generatedAt ? `<span>${t('community.catalog.updatedAt', {date: new Date(state.communityCatalog.generatedAt).toLocaleString()})}</span>` : ''}</div>
      <div id="community-catalog-list" class="community-catalog-list">${renderCommunityProfileCards()}</div>` : ''}
    </section>
  </div>`;
}

function openCommunitySubmission() {
  state.communitySubmission = {open: true, profile: null, fileName: '', result: state.communitySubmission.result};
  render();
}

function closeCommunitySubmission() {
  state.communitySubmission = {...state.communitySubmission, open: false, profile: null, fileName: ''};
  render();
}

async function selectCommunityProfile(file) {
  if (!file) return;
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch {
    throw new Error(t('error.profileJson'));
  }
  validateCommunityProfile(profile);
  state.communitySubmission.profile = profile;
  state.communitySubmission.fileName = file.name;
  const summary = communityProfileSummary(profile);
  const preview = document.querySelector('#community-profile-preview');
  if (preview) {
    preview.className = 'submission-profile-preview ready';
    preview.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(t('community.profileSummary', summary))}</span>`;
  }
}

async function submitCommunityProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.submission-error');
  const submitButton = form.querySelector('button[type="submit"]');
  if (!state.communitySubmission.profile) {
    errorBox.textContent = t('error.communityProfileRequired');
    return;
  }
  const data = new FormData(form);
  const vehicleTag = String(data.get('vehicleTag') || '').trim();
  if (!vehicleTag) {
    errorBox.textContent = t('error.communityVehicleRequired');
    form.elements.vehicleTag?.focus();
    return;
  }
  const customTags = String(data.get('tags') || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  const tags = [...new Set([vehicleTag, ...customTags].filter(Boolean))];
  const metadata = {
    title: String(data.get('title') || '').trim(),
    summary: String(data.get('summary') || '').trim(),
    authorName: String(data.get('authorName') || '').trim(),
    target: state.communitySubmission.profile.compatibility?.target || '',
    tags,
    license: 'CC-BY-4.0',
  };
  const body = {
    format: PROFILE_SUBMISSION_FORMAT,
    version: PROFILE_SUBMISSION_VERSION,
    submittedAt: new Date().toISOString(),
    metadata,
    contact: {phone: String(data.get('phone') || '').trim()},
    consent: {share: true, safetyAcknowledged: true},
    profile: state.communitySubmission.profile,
  };

  errorBox.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = t('community.submitting');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(PROFILE_SUBMISSION_API, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `${response.status} ${response.statusText}`);
    state.communitySubmission = {open: false, profile: null, fileName: '', result};
    state.message = {type: 'ok', text: t('message.communitySubmitted', {number: result.pullRequestNumber})};
    render();
  } catch (error) {
    errorBox.textContent = error.name === 'AbortError' ? t('error.communityTimeout') : (error.message || String(error));
    submitButton.disabled = false;
    submitButton.textContent = t('action.submitCommunity');
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderCommunitySubmission() {
  if (!state.communitySubmission.open) return '';
  return `
    <div class="submission-modal" role="dialog" aria-modal="true" aria-labelledby="community-submission-title">
      <section class="submission-dialog">
        <div class="submission-dialog-heading">
          <div><h2 id="community-submission-title">${t('community.heading')}</h2><div class="helper">${t('community.description')}</div></div>
          <button class="icon-button" type="button" data-action="community-close" aria-label="${t('action.cancel')}">×</button>
        </div>
        <form id="community-submission-form">
          <div class="row"><label for="community-profile-file">${t('community.profileFile')} *</label><input id="community-profile-file" name="profileFile" type="file" accept="application/json,.json" required></div>
          <div id="community-profile-preview" class="submission-profile-preview">${t('community.selectProfileHint')}</div>
          <div class="row"><label for="community-phone">${t('community.phone')}</label><input id="community-phone" name="phone" type="tel" autocomplete="tel" maxlength="32" placeholder="+86 138 0000 0000"><div class="helper">${t('community.phonePrivacy')}</div></div>
          <div class="row"><label for="community-title">${t('community.title')} *</label><input id="community-title" name="title" minlength="3" maxlength="80" required></div>
          <div class="row"><label for="community-summary">${t('community.summary')}</label><textarea id="community-summary" name="summary" maxlength="500"></textarea></div>
          <div class="submission-fields">
            <div class="row"><label for="community-author">${t('community.authorName')}</label><input id="community-author" name="authorName" maxlength="40"></div>
            <div class="row"><label for="community-vehicle">${t('community.vehicleType')} *</label><select id="community-vehicle" name="vehicleTag" required><option value="">${t('community.vehicleNone')}</option><option value="multirotor">${t('community.vehicleMultirotor')}</option><option value="fixed-wing">${t('community.vehicleFixedWing')}</option><option value="vtol">${t('community.vehicleVtol')}</option></select></div>
          </div>
          <div class="row"><label for="community-tags">${t('community.tags')}</label><input id="community-tags" name="tags" maxlength="249" placeholder="${t('community.tagsPlaceholder')}"></div>
          <div class="helper">${t('community.licenseNotice')}</div>
          <div class="submission-error" role="alert"></div>
          <div class="actions"><button class="primary" type="submit">${t('action.submitCommunity')}</button><button class="secondary" type="button" data-action="community-close">${t('action.cancel')}</button></div>
        </form>
      </section>
    </div>`;
}

function renderStatus() {
  const c = config();
  const h = hardware();
  return `<div class="debug-page">
    <div class="grid status-summary-grid">
      <section class="panel">
        <h2>${t('status.device')}</h2>
        <div class="metric"><span>${t('status.target')}</span><strong>${escapeHtml(state.target?.target || c.target || t('value.unknown'))}</strong></div>
        <div class="metric"><span>${t('status.product')}</span><strong>${escapeHtml(state.target?.product_name || c.product_name || t('value.unknown'))}</strong></div>
        <div class="metric"><span>${t('status.firmware')}</span><strong>${escapeHtml(state.target?.version || t('value.unknown'))}</strong></div>
        <div class="metric"><span>${t('status.domain')}</span><strong>${escapeHtml(state.target?.reg_domain || c.reg_domain || t('value.unknown'))}</strong></div>
      </section>
      <section class="panel">
        <h2>${t('status.rx')}</h2>
        <div class="metric"><span>${t('status.uidType')}</span><strong>${escapeHtml(c.uidtype || t('value.unknown'))}</strong></div>
        <div class="metric"><span>${t('status.modelId')}</span><strong>${escapeHtml(c.modelid ?? '255')}</strong></div>
        <div class="metric"><span>${t('status.serialProtocol')}</span><strong>${escapeHtml(serialProtocols.find(([v]) => v === String(c['serial-protocol']))?.[1] || c['serial-protocol'] || 'CRSF')}</strong></div>
        <div class="metric"><span>${t('status.modeChannel')}</span><strong>${Object.entries(configValue('fc_mode_conditions', {rate: [6]})).map(([mode, condition]) => `${mode.toUpperCase()} CH${condition[0]}`).join(' · ') || 'MANUAL'}</strong></div>
        <div class="metric"><span>${t('status.armChannel')}</span><strong>${configValue('fc_arm_enabled', false) ? `CH${escapeHtml(configValue('fc_arm_channel', 5))}` : t('value.disabled')}</strong></div>
      </section>
      <section class="panel">
        <h2>${t('status.sensors')}</h2>
        <div class="metric"><span>${t('status.gyro')}</span><strong>${state.target?.['has-gyro'] ? t('value.detected') : t('value.notDetected')}</strong></div>
        ${state.target?.['has-vbat'] ? `<div class="metric"><span>${t('status.vbat')}</span><strong>${(state.target['vbat-voltage'] * 0.01).toFixed(2)} V</strong></div>` : ''}
      </section>
      <section class="panel profile-panel">
        <h2>${t('profile.heading')}</h2>
        <div class="helper">${t('profile.description')}</div>
        ${state.profileDraft ? `<div class="notice profile-unsaved">${state.target ? t('profile.unsaved') : t('profile.offlineReady')}</div>` : ''}
        ${state.profileImportError ? `<div class="message error">${escapeHtml(t('profile.deviceIncompatible', {message: state.profileImportError}))}</div>` : ''}
        <input id="profile-file" type="file" accept="application/json,.json" hidden>
        <div class="actions">
          <button class="secondary" type="button" data-action="profile-export" ${profileCanExport() ? '' : 'disabled'}>${t('action.exportProfile')}</button>
          <button class="primary" type="button" data-action="profile-import">${t('action.importProfile')}</button>
          <button class="secondary" type="button" data-action="community-catalog-open">${t('action.browseCommunity')}</button>
          <button class="secondary" type="button" data-action="community-submit">${t('action.submitCommunity')}</button>
          ${state.profileDraft ? `<button class="danger" type="button" data-action="profile-discard">${t('action.discardProfile')}</button>` : ''}
        </div>
        ${state.communitySubmission.result ? `<div class="notice community-result">${t('community.pendingReview')} <a href="${escapeHtml(state.communitySubmission.result.pullRequestUrl)}" target="_blank" rel="noopener">#${escapeHtml(state.communitySubmission.result.pullRequestNumber)}</a></div>` : ''}
      </section>
    </div>${renderCommunityCatalog()}${renderCommunitySubmission()}`;
}

function renderRuntime() {
  const o = options();
  return `
    <section class="panel">
      <h2>${t('runtime.heading')}</h2>
      <form id="runtime-form">
        <div class="row"><label for="wifi-on-interval">${t('runtime.wifiInterval')}</label><input id="wifi-on-interval" name="wifi-on-interval" value="${escapeHtml(optionValue('wifi-on-interval', runtimeDefaults['wifi-on-interval']))}" placeholder="${t('placeholder.disabled')}"></div>
        <div class="row"><label for="rcvr-uart-baud">${t('runtime.uartBaud')}</label><input id="rcvr-uart-baud" name="rcvr-uart-baud" value="${escapeHtml(optionValue('rcvr-uart-baud', runtimeDefaults['rcvr-uart-baud']))}" inputmode="numeric"></div>
        <div class="check"><input id="lock-on-first-connection" name="lock-on-first-connection" type="checkbox" ${checked(optionValue('lock-on-first-connection', runtimeDefaults['lock-on-first-connection']))}><label for="lock-on-first-connection">${t('runtime.lockOnFirst')}</label></div>
        <div class="check"><input id="is-airport" name="is-airport" type="checkbox" ${checked(optionValue('is-airport', runtimeDefaults['is-airport']))}><label for="is-airport">${t('runtime.airport')}</label></div>
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="reboot" ${state.busy ? 'disabled' : ''}>${t('action.reboot')}</button></div>
      </form>
    </section>`;
}

function renderModel() {
  const c = config();
  const vbindValue = configValue('vbind', modelDefaults.vbind);
  const modelMatchEnabled = configValue('modelid', modelDefaults.modelid) !== 255;
  const uidPreview = bindingUidPreview();
  const uidType = state.bindingPhrase.trim().length === 0 ? (c.uidtype || state.originalUidType || t('value.unknown')) : t('value.modified');
  return `
    <section class="panel">
      <h2>${t('model.heading')}</h2>
      <form id="model-form">
        <div class="row"><label for="vbind">${t('model.bindStorage')}</label><select id="vbind" name="vbind">${bindStorage.map(([value, getLabel]) => `<option value="${value}" ${selected(vbindValue, value)}>${getLabel()}</option>`).join('')}</select></div>
        <div class="row" id="bindphrase-row" style="display:${vbindValue === 1 ? 'none' : 'grid'};"><label for="phrase">${t('model.bindingPhrase')}</label><input id="phrase" name="phrase" value="${escapeHtml(state.bindingPhrase)}" placeholder="${t('model.bindingPhrase')}"><div class="helper">${t('model.help.bindingPhrase')}</div></div>
        <div class="row" id="uid-row" style="display:${vbindValue === 1 ? 'none' : 'grid'};"><label for="uid-preview">${t('model.generatedUid')}</label><input id="uid-preview" name="uid-preview" value="${escapeHtml(listToPrettyString(uidPreview))}" readonly><div class="badge-row"><span id="uid-type" class="badge">${escapeHtml(uidType)}</span></div></div>
        <div class="check"><input id="model-match" name="model-match" type="checkbox" ${checked(modelMatchEnabled)}><label for="model-match">${t('model.enableModelMatch')}</label></div>
        <div class="row" id="modelid-row" style="display:${modelMatchEnabled ? 'grid' : 'none'};"><label for="modelid">${t('model.modelId')}</label><input id="modelid" name="modelid" value="${escapeHtml(configValue('modelid', modelDefaults.modelid))}" inputmode="numeric"></div>
        <div class="row"><label for="serial-protocol">${t('model.serialProtocol')}</label><select id="serial-protocol" name="serial-protocol">${serialProtocols.map(([value, label]) => `<option value="${value}" ${selected(configValue('serial-protocol', modelDefaults['serial-protocol']), value)}>${label}</option>`).join('')}</select></div>
        <div class="row"><label for="sbus-failsafe">${t('model.sbusFailsafe')}</label><select id="sbus-failsafe" name="sbus-failsafe"><option value="0" ${selected(configValue('sbus-failsafe', modelDefaults['sbus-failsafe']), 0)}>${t('sbusFailsafe.noPulses')}</option><option value="1" ${selected(configValue('sbus-failsafe', modelDefaults['sbus-failsafe']), 1)}>${t('sbusFailsafe.lastPosition')}</option></select></div>
        <div class="check"><input id="force-tlm" name="force-tlm" type="checkbox" ${checked(configValue('force-tlm', modelDefaults['force-tlm']))}><label for="force-tlm">${t('model.forceTelemetry')}</label></div>
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="danger" type="button" data-action="reset-model">${t('action.resetModel')}</button></div>
      </form>
    </section>`;
}

function renderPwm() {
  if (state.beginnerMode) {
    const usageProfile = currentCommunityUsageProfile();
    const usage = communityUsageInstructions(usageProfile);
    const hasMixer = Array.isArray(usageProfile.flight.mixer) && usageProfile.flight.mixer.length > 0;
    return `
      <section class="panel beginner-pwm-panel">
        <h2>${t('pwm.heading')}</h2>
        <div class="notice">${t('pwm.beginnerModeUnsupported')}</div>
        <div class="community-usage beginner-pwm-usage">
          <strong>${t('community.catalog.usageHeading')}</strong>
          ${!hasMixer ? `<div class="helper">${t('pwm.beginnerModeNoMixer')}</div>` : usage.length ? `<ul>${usage.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : `<div class="helper">${t('community.catalog.usageEmpty')}</div>`}
        </div>
      </section>`;
  }
  const entries = pwmEntries();
  const outputLimits = pwmOutputLimits();
  const runtimeValues = pwmOutputWifiValues();
  const offline = !pwmConnected();
  if (!entries.length) {
    return `
      <section class="panel">
        <h2>${t('pwm.headingShort')}</h2>
        <div class="notice">${t('pwm.noPwmNotice')}</div>
      </section>`;
  }

  const serial2Visible = pwmSerial2Active();
  return `
    <section class="panel">
      <h2>${t('pwm.heading')}</h2>
      ${offline ? `<div class="notice">${t('pwm.offlineNotice')}</div>` : ''}
      ${state.profileDraft?.pwm ? `<div class="notice profile-unsaved">${t('profile.pwmUnsaved')}</div>` : ''}
      <div class="helper pwm-help">
        ${t('pwm.help.general')}
      </div>
      <form id="pwm-form">
        <div class="table-shell">
          <table class="grid-table pwm-table">
            <thead>
              <tr>
                <th>${t('pwm.output')}</th>
                <th>${t('pwm.pin')}</th>
                <th>${t('pwm.features')}</th>
                <th>${t('pwm.mode')}</th>
                <th>${t('pwm.source')}</th>
                <th>${t('pwm.input')}</th>
                <th>${t('pwm.invert')}</th>
                <th>${t('pwm.polarityInvert')}</th>
                <th>${t('pwm.narrow')}</th>
                <th>${t('pwm.failsafe')}</th>
                <th>${t('pwm.position')}</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map((entry, index) => {
                const decoded = decodePwmConfig(entry.config);
                const disabledRow = decoded.mode > 9;
                const failsafeDisabled = disabledRow || decoded.failsafeMode !== 0;
                return `
                  <tr data-pwm-row="${index}">
                    <th scope="row" data-label="${escapeHtml(t('pwm.output'))}">${index + 1}</th>
                    <td data-label="${escapeHtml(t('pwm.pin'))}">${escapeHtml(entry.pin)}</td>
                    <td data-label="${escapeHtml(t('pwm.features'))}"><div class="badge-row pwm-badges">${pwmFeatureBadges(entry.features)}</div></td>
                    <td data-label="${escapeHtml(t('pwm.mode'))}"><select name="pwm-mode-${index}" data-pwm-mode="${index}">${renderPwmModeOptions(entry.features, decoded.mode)}</select></td>
                    <td data-label="${escapeHtml(t('pwm.source'))}"><select name="pwm-source-${index}" data-pwm-dependent="${index}"><option value="0" ${selected(decoded.mixerMode ? 1 : 0, 0)}>${t('pwm.sourceRc')}</option><option value="1" ${selected(decoded.mixerMode ? 1 : 0, 1)}>${t('pwm.sourceMixer')}</option></select></td>
                    <td data-label="${escapeHtml(t('pwm.input'))}"><select name="pwm-input-${index}" data-pwm-dependent="${index}">${pwmInputLabels.map((label, value) => `<option value="${value}" ${selected(decoded.inputChannel, value)}>${label}</option>`).join('')}</select></td>
                    <td data-label="${escapeHtml(t('pwm.invert'))}"><input name="pwm-invert-${index}" type="checkbox" data-pwm-dependent="${index}" ${checked(decoded.inverted)} ${disabled(disabledRow)}></td>
                    <td data-label="${escapeHtml(t('pwm.polarityInvert'))}"><input name="pwm-polarity-${index}" type="checkbox" data-pwm-polarity="${index}" ${checked(decoded.signalPolarityInverted)}></td>
                    <td data-label="${escapeHtml(t('pwm.narrow'))}"><input name="pwm-narrow-${index}" type="checkbox" data-pwm-dependent="${index}" ${checked(decoded.narrow)} ${disabled(disabledRow)}></td>
                    <td data-label="${escapeHtml(t('pwm.failsafe'))}"><select name="pwm-failsafe-mode-${index}" data-pwm-failsafe-mode="${index}" data-pwm-dependent="${index}" ${disabled(disabledRow)}>${pwmFailsafeModes.map((getLabel, value) => `<option value="${value}" ${selected(decoded.failsafeMode, value)}>${getLabel()}</option>`).join('')}</select></td>
                    <td data-label="${escapeHtml(t('pwm.position'))}"><input name="pwm-failsafe-${index}" type="number" min="988" max="2011" value="${escapeHtml(decoded.failsafe)}" data-pwm-failsafe="${index}" data-pwm-dependent="${index}" ${disabled(failsafeDisabled)}></td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <h3 class="pwm-limits-heading">${t('pwm.limits.heading')}</h3>
        <div class="helper pwm-help">${t('pwm.limits.help')}</div>
        <div class="table-shell pwm-limits-shell">
          <table class="grid-table pwm-limits-table">
            <thead>
              <tr>
                <th>${t('pwm.output')}</th>
                <th>${t('pwm.limits.min')}</th>
                <th>${t('pwm.limits.center')}</th>
                <th>${t('pwm.limits.max')}</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map((entry, index) => `
                <tr>
                  <th scope="row" data-label="${escapeHtml(t('pwm.output'))}">${index + 1}</th>
                  <td data-label="${escapeHtml(t('pwm.limits.min'))}"><input name="pwm-limit-min-${index}" data-pwm-limit="${index}" type="number" min="500" max="2498" value="${escapeHtml(outputLimits[index][0])}"></td>
                  <td data-label="${escapeHtml(t('pwm.limits.center'))}"><input name="pwm-limit-center-${index}" data-pwm-limit="${index}" type="number" min="501" max="2499" value="${escapeHtml(outputLimits[index][1])}"></td>
                  <td data-label="${escapeHtml(t('pwm.limits.max'))}"><input name="pwm-limit-max-${index}" data-pwm-limit="${index}" type="number" min="502" max="2500" value="${escapeHtml(outputLimits[index][2])}"></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <h3 class="pwm-runtime-heading">${t('pwm.wifiOutput.heading')}</h3>
        <div class="check pwm-wifi-output-option">
          <input id="pwm-output-wifi-enabled" name="pwm_output_wifi_enabled" type="checkbox" ${checked(pwmOutputWifiEnabled())}>
          <label for="pwm-output-wifi-enabled">
            ${t('pwm.wifiOutput.label')}
            <small>${t('pwm.wifiOutput.help')}</small>
          </label>
        </div>
        <div class="pwm-runtime-controls">
          ${entries.map((entry, index) => `
            <div class="pwm-runtime-control">
              <label for="pwm-runtime-${index}">${t('pwm.output')} ${index + 1} · GPIO ${escapeHtml(entry.pin)}</label>
              <input id="pwm-runtime-${index}" name="pwm-runtime-${index}" data-pwm-runtime="${index}" type="range"
                min="${escapeHtml(outputLimits[index][0])}" max="${escapeHtml(outputLimits[index][2])}" step="1"
                value="${escapeHtml(runtimeValues[index])}"
                ${disabled(!pwmOutputWifiEnabled() || decodePwmConfig(entry.config).mode > 5)}>
              <output data-pwm-runtime-value="${index}" for="pwm-runtime-${index}">${escapeHtml(runtimeValues[index])} us</output>
            </div>`).join('')}
        </div>
        <div class="row" id="serial1-config-row" style="display:${serial2Visible ? 'grid' : 'none'};">
          <label for="serial1-protocol">${t('pwm.serial2Protocol')}</label>
          <select id="serial1-protocol" name="serial1-protocol">${serial1Protocols.map(([value, label]) => `<option value="${value}" ${selected(state.profileDraft?.serial1Protocol ?? configValue('serial1-protocol', 0), value)}>${label}</option>`).join('')}</select>
          <div class="helper">${t('pwm.help.serial2')}</div>
        </div>
        <div class="actions"><button class="primary" ${state.busy || offline || state.profileImportError ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="refresh">${t('action.refresh')}</button></div>
      </form>
    </section>`;
}

function motorCount() {
  const mixerData = flightConfigValue('fc_mixer', []);
  const configCount = flightConfigValue('fc_mixer_count', undefined);
  const hasExplicitCount = Number.isFinite(Number(configCount));
  const base = hasExplicitCount
    ? Math.max(0, Math.floor(Number(configCount) / 4))
    : Math.max(1, Math.floor(mixerData.length / 4) || 1);
  return base + (state.extraMixerRows || 0);
}

function changeMixerRowCount(delta) {
  const tbody = document.querySelector('#flight-form [data-grid-table="fc_mixer"] tbody');
  if (!tbody) return;

  if (delta > 0) {
    const rowIndex = motorCount();
    state.extraMixerRows = (state.extraMixerRows || 0) + 1;
    tbody.insertAdjacentHTML('beforeend', renderNumGridRow(
      'fc_mixer',
      `${t('flight.output')} ${rowIndex + 1}`,
      4,
      [],
      rowIndex,
      '',
      {flagName: 'fc-mixer-servo', flagValues: []},
    ));
  } else if (state.extraMixerRows > 0) {
    tbody.lastElementChild?.remove();
    state.extraMixerRows -= 1;
  }

  const motors = motorCount();
  const countLabel = document.querySelector('#mixer-motor-count');
  if (countLabel) {
    countLabel.textContent = `${motors} ${motors !== 1 ? t('flight.outputs') : t('flight.output')}`;
  }
  const removeButton = document.querySelector('[data-action="remove-motor"]');
  if (removeButton) removeButton.disabled = state.busy || state.extraMixerRows <= 0;
}

function deg(rad) { return rad * 180 / Math.PI; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function orientationMatrixOrIdentity(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const values = matrix.slice(0, 9).map(Number);
  return values.every(Number.isFinite) ? values : [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function eulerFromMatrix(m) {
  // Decompose 3x3 rotation matrix (ZYX convention) into [roll, pitch, yaw] degrees.
  // R = Rz(yaw) * Ry(pitch) * Rx(roll)
  if (!m || m.length < 9) return [0, 0, 0];
  const m00 = numCellValue(m, 0), m01 = numCellValue(m, 1), m02 = numCellValue(m, 2);
  const m10 = numCellValue(m, 3), m11 = numCellValue(m, 4), m12 = numCellValue(m, 5);
  const m20 = numCellValue(m, 6), m21 = numCellValue(m, 7), m22 = numCellValue(m, 8);

  const pitch = Math.asin(clamp(-m20, -1, 1));
  const cosPitch = Math.cos(pitch);
  let roll, yaw;
  if (Math.abs(cosPitch) > 0.0001) {
    roll = Math.atan2(m21, m22);
    yaw = Math.atan2(m10, m00);
  } else {
    roll = 0;
    yaw = Math.atan2(-m01, m11);
  }
  return [roll, pitch, yaw].map((value) => Math.round(deg(value) * 10) / 10);
}

function transposeMatrix3(m) {
  if (!m || m.length < 9) return [];
  return [
    numCellValue(m, 0), numCellValue(m, 3), numCellValue(m, 6),
    numCellValue(m, 1), numCellValue(m, 4), numCellValue(m, 7),
    numCellValue(m, 2), numCellValue(m, 5), numCellValue(m, 8),
  ];
}

function installEulerFromOrientationMatrix(m) {
  // Hardware JSON stores the firmware raw->internal matrix. Show users the
  // inverse because the UI labels are physical install roll/pitch/yaw.
  return eulerFromMatrix(transposeMatrix3(m));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function boardPreviewTransform(roll, pitch, yaw) {
  // The board graphic's forward edge is the on-screen front arrow.
  return `rotateZ(${-yaw}deg) rotateY(${roll}deg) rotateX(${pitch}deg)`;
}

function renderActivationRange(id, label, description, range, tone, disabled = false, channel = null, auxOptions = null) {
  const start = clamp(Number(range?.[0]) || 900, 900, 2075);
  const end = clamp(Number(range?.[1]) || 2100, start + 25, 2100);
  const startPercent = ((start - 900) / 1200) * 100;
  const endPercent = ((end - 900) / 1200) * 100;
  const disabledAttribute = disabled ? 'disabled' : '';
  return `
    <div class="mode-range-card ${disabled ? 'is-disabled' : ''}" data-mode-range style="--range-color:${tone}; --range-start:${startPercent}%; --range-end:${endPercent}%">
      <div class="mode-range-info">
        <div class="mode-range-name"><span class="mode-dot"></span>${channel === null ? `<strong>${label}</strong>` : `<label class="arm-toggle"><input name="fc_${id}_enabled" data-mode-enabled type="checkbox" ${checked(!disabled)}><strong>${label}</strong></label>`}</div>
        <span>${description}</span>
        ${channel === null ? '' : `<label class="mode-channel"><span>${t('flight.modeChannel')}</span><select name="fc_${id}_channel" ${disabledAttribute}>${auxOptions(channel)}</select></label>`}
      </div>
      <div class="mode-range-control">
        <div class="mode-range-values">
          <label><span>${t('flight.rangeMin')}</span><span class="mode-value-input"><input data-range-number="start" type="number" min="900" max="2075" step="25" value="${start}" ${disabledAttribute}><small>&micro;s</small></span></label>
          <span class="mode-range-separator">&ndash;</span>
          <label><span>${t('flight.rangeMax')}</span><span class="mode-value-input"><input data-range-number="end" type="number" min="925" max="2100" step="25" value="${end}" ${disabledAttribute}><small>&micro;s</small></span></label>
        </div>
        <div class="mode-slider">
          <div class="mode-slider-track"><span data-range-fill title="${t('flight.dragRange')}"></span></div>
          <input name="fc_${id}_start" data-range-handle="start" type="range" min="900" max="2100" step="25" value="${start}" aria-label="${label} ${t('flight.rangeMin')}" ${disabledAttribute}>
          <input name="fc_${id}_end" data-range-handle="end" type="range" min="900" max="2100" step="25" value="${end}" aria-label="${label} ${t('flight.rangeMax')}" ${disabledAttribute}>
        </div>
        <div class="mode-range-scale" aria-hidden="true"><span>900</span><span>1200</span><span>1500</span><span>1800</span><span>2100</span></div>
      </div>
    </div>`;
}

function renderImuCalibration(angleEnabled) {
  const calibration = state.imuCalibration;
  const completed = calibration.accelFaces.filter(Boolean).length;
  const gyroBias = calibration.gyroBias || configValue('fc_gyro_bias', [0, 0, 0]);
  const accelBias = calibration.accelBias || configValue('fc_accel_bias', [0, 0, 0]);
  const accelScale = calibration.accelScale || configValue('fc_accel_scale', [1, 1, 1]);
  const busy = Boolean(calibration.busy || state.orientationCal.busy);
  const gyroBiasMode = Number(flightConfigValue('fc_gyro_bias_mode', 0));
  const faceButtons = ACCEL_CAL_FACES.map((face, index) => {
    const done = Boolean(calibration.accelFaces[index]);
    const classes = ['imu-face-button', done ? 'is-done' : 'is-pending'].join(' ');
    return `<div class="${classes}" aria-label="${escapeHtml(t(face.label))}: ${escapeHtml(t(done ? 'imuCalibration.faceDone' : 'imuCalibration.facePending'))}">
      <span>${done ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9"/></svg>' : index + 1}</span><strong>${escapeHtml(t(face.label))}</strong><small>${escapeHtml(t(done ? 'imuCalibration.faceDone' : 'imuCalibration.facePending'))}</small>
    </div>`;
  }).join('');
  return `
    <section class="imu-calibration-section">
      <label>${t('imuCalibration.heading')}</label>
      <div class="notice">${t('imuCalibration.safety')}</div>
      <div class="imu-calibration-grid">
        <section class="imu-cal-card ${calibration.busy === 'accel-detect' ? 'is-calibrating' : ''}" data-angle-calibration ${angleEnabled ? '' : 'hidden'}>
          <div class="imu-card-heading">
            <div><h3>${t('imuCalibration.accelTitle')}</h3><p>${t('imuCalibration.accelDescription')}</p></div>
            <span class="cal-progress">${t('imuCalibration.progress', {done: completed})}</span>
          </div>
          <div class="imu-step-hint">${completed < ACCEL_CAL_FACES.length
            ? t('imuCalibration.autoFaceHint')
            : t('imuCalibration.accelReady')}</div>
          <div class="imu-face-actions">${faceButtons}</div>
          <div class="actions"><button class="primary" type="button" data-action="accel-next" ${state.busy || busy || completed >= ACCEL_CAL_FACES.length ? 'disabled' : ''}>${t('imuCalibration.nextStep')}</button><button class="secondary" type="button" data-action="accel-reset" ${state.busy || busy ? 'disabled' : ''}>${t('imuCalibration.resetAccel')}</button></div>
          <div class="imu-card-results imu-accel-results">
            <div><strong>${t('imuCalibration.accelBias')}</strong>${renderNumGrid('fc_accel_bias', [t('imuCalibration.offset')], ['X', 'Y', 'Z'], accelBias, {rowHeader: t('flight.axis')})}</div>
            <div><strong>${t('imuCalibration.accelScale')}</strong>${renderNumGrid('fc_accel_scale', [t('imuCalibration.scale')], ['X', 'Y', 'Z'], accelScale, {rowHeader: t('flight.axis')})}</div>
          </div>
          ${calibration.busy === 'accel-detect' ? `<div class="calibrating-overlay" role="status" aria-live="polite"><span aria-hidden="true"></span>${t('imuCalibration.detectingFace')}</div>` : ''}
        </section>
        <section class="imu-cal-card ${calibration.busy === 'gyro' ? 'is-calibrating' : ''}">
          <div class="imu-card-heading">
            <div><h3>${t('imuCalibration.gyroTitle')}</h3><p>${t('imuCalibration.gyroDescription')}</p></div>
            ${calibration.gyroBias ? `<span class="cal-ready">${t('imuCalibration.ready')}</span>` : ''}
          </div>
          <div class="gyro-calibration-body">
            <fieldset class="gyro-bias-mode">
              <legend>${t('imuCalibration.gyroBiasMode')}</legend>
              <div class="gyro-bias-options">
                <label class="gyro-bias-option">
                  <input type="radio" name="fc_gyro_bias_mode" value="0" ${checked(gyroBiasMode === 0)}>
                  <span class="gyro-bias-status" aria-hidden="true"></span>
                  <span class="gyro-bias-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>
                  <span class="gyro-bias-option-content"><strong>${t('imuCalibration.configuredBias')}</strong><small>${t('imuCalibration.configuredBiasHelp')}</small></span>
                </label>
                <label class="gyro-bias-option">
                  <input type="radio" name="fc_gyro_bias_mode" value="1" ${checked(gyroBiasMode === 1)}>
                  <span class="gyro-bias-status" aria-hidden="true"></span>
                  <span class="gyro-bias-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>
                  <span class="gyro-bias-option-content"><span class="gyro-bias-option-title"><strong>${t('imuCalibration.armSampleBias')}</strong><em>${t('imuCalibration.quadcopterRecommended')}</em></span><small>${t('imuCalibration.armSampleBiasHelp')}</small></span>
                </label>
              </div>
            </fieldset>
            <div class="gyro-calibration-action" data-gyro-calibration-action style="display:${gyroBiasMode === 1 ? 'none' : 'flex'}">
              <div class="gyro-still-visual"><div class="gyro-icon" aria-hidden="true">⊕</div><strong>${t('imuCalibration.keepStill')}</strong><small>${t('imuCalibration.gyroDuration')}</small></div>
              <div class="actions"><button class="secondary" type="button" data-action="gyro-calibrate" ${state.busy || busy || gyroBiasMode === 1 ? 'disabled' : ''}>${t('imuCalibration.startGyro')}</button></div>
            </div>
          </div>
          <div class="imu-card-results imu-gyro-results" data-gyro-bias-results style="display:${gyroBiasMode === 1 ? 'none' : 'grid'}">
            <div><strong>${t('imuCalibration.gyroBias')}</strong>${renderNumGrid('fc_gyro_bias', [t('imuCalibration.offset')], ['X', 'Y', 'Z'], gyroBias, {rowHeader: t('flight.axis')})}</div>
          </div>
          ${calibration.busy === 'gyro' ? `<div class="calibrating-overlay" role="status" aria-live="polite"><span aria-hidden="true"></span>${t('imuCalibration.sampling')}</div>` : ''}
        </section>
      </div>
      <div class="helper">${t('imuCalibration.saveHelp')}</div>
    </section>`;
}

function renderOrientationCalibration(installEuler) {
  const calibration = state.orientationCal;
  const completed = calibration.samples.filter(Boolean).length;
  const nextIndex = calibration.samples.findIndex((sample) => !sample);
  const faceStatus = ORIENTATION_CAL_STEPS.map((step, orderIndex) => {
    const done = Boolean(calibration.samples[orderIndex]);
    const current = orderIndex === nextIndex;
    const classes = ['imu-face-button', done ? 'is-done' : 'is-pending', current ? 'is-current' : ''].filter(Boolean).join(' ');
    const statusKey = done ? 'imuCalibration.faceDone' : (current ? 'orient.faceCurrent' : 'imuCalibration.facePending');
    return `<div class="${classes}" aria-label="${escapeHtml(t(step.label))}: ${escapeHtml(t(statusKey))}">
      <span>${done ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9"/></svg>' : orderIndex + 1}</span><strong>${escapeHtml(t(step.label))}</strong><small>${escapeHtml(t(statusKey))}</small>
    </div>`;
  }).join('');
  const hint = nextIndex >= 0
    ? t(nextIndex === 0 ? 'orient.topUpInstruction' : 'orient.noseUpInstruction')
    : t('orient.ready', {
      roll: Number(calibration.levelCorrectionDeg?.[0] || 0).toFixed(1),
      pitch: Number(calibration.levelCorrectionDeg?.[1] || 0).toFixed(1),
    });
  const poseStepIndex = nextIndex >= 0 ? nextIndex : ORIENTATION_CAL_STEPS.length - 1;
  const poseStep = ORIENTATION_CAL_STEPS[poseStepIndex];
  return `
    <div class="orientation-editor">
      <div class="orientation-calibration-layout">
        <section class="imu-cal-card orientation-cal-card ${calibration.busy ? 'is-calibrating' : ''}">
          <div class="imu-card-heading">
            <div><h3>${t('orient.heading')}</h3><p>${t('orient.description')}</p></div>
            <span class="cal-progress">${t('orient.progress', {done: completed})}</span>
          </div>
          <div class="notice">${t('orient.safety')}</div>
          <div class="imu-step-hint">${escapeHtml(hint)}</div>
          <div class="imu-face-actions">${faceStatus}</div>
          <div class="actions"><button class="primary" type="button" data-action="orientation-next" ${state.busy || calibration.busy || state.imuCalibration.busy || nextIndex < 0 ? 'disabled' : ''}>${t('orient.capture')}</button><button class="secondary" type="button" data-action="orientation-reset" ${state.busy || calibration.busy || state.imuCalibration.busy ? 'disabled' : ''}>${t('orient.reset')}</button></div>
          ${calibration.busy ? `<div class="calibrating-overlay" role="status" aria-live="polite"><span aria-hidden="true"></span>${t('imuCalibration.sampling')}</div>` : ''}
        </section>
        <aside class="orientation-pose-card" aria-label="${escapeHtml(t('orient.poseTitle'))}">
          <div class="orientation-pose-heading"><span>${t('orient.poseTitle')}</span><strong>${escapeHtml(t(poseStep.label))}</strong></div>
          <div id="orientation-aircraft-wrapper" class="orientation-aircraft-wrapper">
            <canvas id="orientation-aircraft-canvas" aria-label="${escapeHtml(t('orient.poseCanvasLabel', {face: t(poseStep.label)}))}"></canvas>
          </div>
          <div class="helper">${t(poseStepIndex === 0 ? 'orient.topUpPoseHelp' : 'orient.noseUpPoseHelp')}</div>
        </aside>
      </div>
      <section class="orientation-results-card">
        <div class="orientation-results-heading"><strong>${t('orient.eulerResult')}</strong><span>${t('orient.resultReadOnly')}</span></div>
        <div class="orientation-results-layout">
          <div class="imu-cal-results orientation-results">
            <div>${renderNumGrid('orientation-euler-result', [t('orient.installAngle')], [t('flight.roll'), t('flight.pitch'), t('flight.yaw')], installEuler, {rowHeader: t('flight.axis'), disabled: true})}</div>
          </div>
          <div class="preview-scene orientation-board-preview" aria-label="${escapeHtml(t('flight.boardOrientation'))}">
            <div class="preview-scene-inner">
              <div class="preview-board" style="transform:${boardPreviewTransform(installEuler[0], installEuler[1], installEuler[2])}">
                <div class="board-top">
                  <div class="board-chip">▲</div>
                  <div class="board-label">${escapeHtml(t('flight.boardLabel'))}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="helper">${t('orient.saveHelp')}</div>
      </section>
    </div>`;
}

function renderFlight() {
  const motors = motorCount();
  const ratePid = flightConfigValue('fc_rate_pid', []);
  const anglePid = flightConfigValue('fc_angle_pid', []);
  const angleRateLimits = flightConfigValue('fc_angle_rate_limits_dps', [100, 100]);
  const dtermLpfHz = flightConfigValue('fc_dterm_lpf_hz', 20);
  const gyroLpfHz = flightConfigValue('fc_gyro_lpf_hz', 30);
  const angleEnabled = Boolean(flightConfigValue('fc_mode_conditions', {rate: [6, 1300, 2100]}).angle);
  const mixer = flightConfigValue('fc_mixer', []);
  const mixerServos = flightConfigValue('fc_mixer_servos', []);
  const modeConditions = flightConfigValue('fc_mode_conditions', {rate: [6, 1300, 1700]});
  const wifiConditions = flightConfigValue('fc_wifi_conditions', {});
  const armEnabled = flightConfigValue('fc_arm_enabled', false);
  const armChannel = flightConfigValue('fc_arm_channel', 5);
  const armRange = flightConfigValue('fc_arm_range', [1700, 2100]);
  const auxOptions = (selectedChannel) => pwmInputLabels.slice(4).map((label, index) => `<option value="${index + 5}" ${selected(selectedChannel, index + 5)}>${label}</option>`).join('');
  const matrix = orientationMatrixOrIdentity(state.orientationMatrix);
  const installEuler = installEulerFromOrientationMatrix(matrix);
  if (state.beginnerMode) {
    const sensitivityAxes = [
      ['roll', t('flight.roll'), ratePid[0]],
      ['pitch', t('flight.pitch'), ratePid[4]],
      ['yaw', t('flight.yaw'), ratePid[8]],
    ];
    return `
      <section class="panel beginner-flight-panel">
        <h2>${t('flight.heading')}</h2>
        <form id="flight-form">
          <section class="beginner-sensitivity-card">
            <div class="beginner-sensitivity-header"><h3>${t('flight.beginnerSensitivity')}</h3><p>${t('flight.beginnerSensitivityHelp')}</p></div>
            <div class="beginner-sensitivity-grid">
              ${sensitivityAxes.map(([axis, label, gain]) => {
                const level = beginnerSensitivityLevel(gain);
                return `<label class="beginner-sensitivity-field" for="beginner-sensitivity-${axis}">
                  <span class="beginner-sensitivity-label"><strong>${label}</strong><output data-beginner-sensitivity-output="${axis}">${t('flight.beginnerSensitivityValue', {level, value: beginnerSensitivityGain(level).toFixed(1)})}</output></span>
                  <input id="beginner-sensitivity-${axis}" name="beginner-sensitivity-${['roll', 'pitch', 'yaw'].indexOf(axis)}" data-beginner-sensitivity="${axis}" type="range" min="1" max="10" step="1" value="${level}">
                </label>`;
              }).join('')}
            </div>
          </section>
          ${renderOrientationCalibration(installEuler)}
          <div class="actions"><button class="primary" ${state.busy || state.imuCalibration.busy || state.orientationCal.busy || !state.target || state.profileImportError ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="reboot" ${state.busy || state.imuCalibration.busy || state.orientationCal.busy ? 'disabled' : ''}>${t('action.reboot')}</button></div>
        </form>
      </section>`;
  }
  return `
    <section class="panel">
      <h2>${t('flight.heading')}</h2>
      ${state.profileDraft?.flight ? `<div class="notice profile-unsaved">${t('profile.flightUnsaved')}</div>` : ''}
      <form id="flight-form">
        <div class="mode-config">
          <div class="mode-config-header">
            <div><h3>${t('flight.modeRanges')}</h3><div class="helper">${t('flight.rangeHelp')}</div></div>
          </div>
          <div class="mode-range-list">
            ${renderActivationRange('rate', 'RATE', t('flight.rateDescription'), modeConditions.rate?.slice(1) ?? [1300, 1700], '#2f80c4', !modeConditions.rate, modeConditions.rate?.[0] ?? 6, auxOptions)}
            ${renderActivationRange('angle', 'ANGLE', t('flight.angleDescription'), modeConditions.angle?.slice(1) ?? [1700, 2100], '#1f8f75', !modeConditions.angle, modeConditions.angle?.[0] ?? 6, auxOptions)}
          </div>
        </div>
        <div class="mode-config arm-config" id="arm-mode-config">
          <div class="mode-config-header">
            <label class="arm-toggle" for="fc_arm_enabled"><input id="fc_arm_enabled" name="fc_arm_enabled" type="checkbox" ${checked(armEnabled)}><span><strong>${t('flight.armEnabled')}</strong><small>${t('flight.armDescription')}</small></span></label>
            <label class="mode-channel" for="fc_arm_channel"><span>${t('flight.armChannel')}</span><select id="fc_arm_channel" name="fc_arm_channel" ${armEnabled ? '' : 'disabled'}>${auxOptions(armChannel)}</select></label>
          </div>
          ${renderActivationRange('arm', 'ARM', t('flight.armRangeDescription'), armRange, '#d97706', !armEnabled)}
        </div>
        <div class="mode-config">
          <div class="mode-config-header">
            <div><h3>${t('flight.wifiModeRanges')}</h3><div class="helper">${t('flight.wifiRangeHelp')}</div></div>
          </div>
          <div class="mode-range-list">
            ${renderActivationRange('wifi_coexist', t('flight.wifiCoexist'), t('flight.wifiCoexistDescription'), wifiConditions.coexist?.slice(1) ?? [1700, 2100], '#0891b2', !wifiConditions.coexist, wifiConditions.coexist?.[0] ?? 7, auxOptions)}
          </div>
        </div>
        <div class="notice">${t('notice.rateLoop')}</div>
        <div class="filter-config">
          <div class="filter-config-header"><div><h3>${t('flight.filterSettings')}</h3><div class="helper">${t('flight.filterSettingsHelp')}</div></div></div>
          <div class="filter-config-body">
            <div class="filter-lpf-grid">
              <div class="row">
                <label for="fc_gyro_lpf_hz">${t('flight.gyroLpf')}</label>
                <input id="fc_gyro_lpf_hz" name="fc_gyro_lpf_hz" type="number" min="0" max="100" step="1" value="${escapeHtml(gyroLpfHz)}">
                <div class="helper">${t('flight.gyroLpfHelp')}</div>
              </div>
              <div class="row">
                <label for="fc_dterm_lpf_hz">${t('flight.dtermLpf')}</label>
                <input id="fc_dterm_lpf_hz" name="fc_dterm_lpf_hz" type="number" min="0" max="100" step="1" value="${escapeHtml(dtermLpfHz)}">
                <div class="helper">${t('flight.dtermLpfHelp')}</div>
              </div>
            </div>
          </div>
        </div>
        <section class="flight-setting-card">
          <div class="flight-setting-card-header"><h3>${t('flight.ratePid')}</h3><p>${t('flight.ratePidHelp')}</p></div>
          <div class="flight-setting-card-body">${renderNumGrid('fc_rate_pid', [t('flight.roll'), t('flight.pitch'), t('flight.yaw')], [t('flight.kp'), t('flight.ki'), t('flight.kd'), t('flight.iLimit')], ratePid, {rowHeader: t('flight.axis')})}</div>
        </section>
        <section class="flight-setting-card angle-rate-limit-card" id="angle-rate-limit-card" data-angle-setting style="display:${angleEnabled ? 'block' : 'none'}">
          <div class="flight-setting-card-header"><h3>${t('flight.angleRateLimits')}</h3><p>${t('flight.angleRateLimitsHelp')}</p></div>
          <div class="flight-setting-card-body angle-rate-limit-grid">
            ${[['roll', t('flight.roll'), angleRateLimits[0] ?? 100], ['pitch', t('flight.pitch'), angleRateLimits[1] ?? 100]].map(([axis, label, value]) => `
              <label class="angle-rate-limit-field" for="fc-angle-rate-limit-${axis}">
                <span><strong>${label}</strong><small>${t('flight.angleRateLimit')}</small></span>
                <span class="number-with-unit"><input id="fc-angle-rate-limit-${axis}" name="fc_angle_rate_limit_${axis}_dps" type="number" min="1" max="1000" step="1" value="${escapeHtml(value)}"><small>°/s</small></span>
              </label>`).join('')}
          </div>
        </section>
        <section class="flight-setting-card" id="angle-pid-row" data-angle-setting style="display:${angleEnabled ? 'block' : 'none'}">
          <div class="flight-setting-card-header"><h3>${t('flight.anglePid')}</h3><p>${t('flight.anglePidHelp')}</p></div>
          <div class="flight-setting-card-body">${renderNumGrid('fc_angle_pid', [t('flight.roll'), t('flight.pitch'), t('flight.yaw')], [t('flight.kp'), t('flight.ki'), t('flight.kd'), t('flight.iLimit')], anglePid, {rowHeader: t('flight.axis')})}</div>
        </section>
        <section class="flight-setting-card">
          <div class="flight-setting-card-header"><h3>${t('flight.mixer')}</h3><p>${t('flight.mixerHelp')}</p></div>
          <div class="flight-setting-card-body">
          ${renderNumGrid('fc_mixer', Array.from({length: motors}, (_, i) => `${t('flight.output')} ${i + 1}`), [t('flight.throttle'), t('flight.roll'), t('flight.pitch'), t('flight.yaw')], mixer, {
            rowHeader: t('flight.output'),
            flagName: 'fc-mixer-servo',
            flagLabel: t('flight.isServo'),
            flagValues: mixerServos,
          })}
          <div class="helper">${t('flight.mixerServoHelp')}</div>
          <div class="helper" id="mixer-motor-count">${motors} ${motors !== 1 ? t('flight.outputs') : t('flight.output')}</div>
          <div class="actions">
            <button class="secondary" type="button" data-action="add-motor" ${state.busy ? 'disabled' : ''}>${t('action.addOutput')}</button>
            <button class="secondary" type="button" data-action="remove-motor" ${state.busy || state.extraMixerRows <= 0 ? 'disabled' : ''}>${t('action.removeOutput')}</button>
          </div>
          </div>
        </section>
        <div class="row">
          <label>${t('flight.boardOrientation')}</label>
          ${renderOrientationCalibration(installEuler)}
        </div>
        <div id="imu-calibration">${renderImuCalibration(angleEnabled)}</div>
        <div class="actions"><button class="primary" ${state.busy || state.imuCalibration.busy || state.orientationCal.busy || !state.target || state.profileImportError ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="reboot" ${state.busy || state.imuCalibration.busy || state.orientationCal.busy ? 'disabled' : ''}>${t('action.reboot')}</button></div>
      </form>
    </section>`;
}

function renderDebug() {
  const sample = state.debugSample;
  return `
    <div class="grid debug-summary-grid">
      <section class="panel">
        <h2>${t('debug.headingPolling')}</h2>
        <div class="row">
          <label for="debug-poll-rate">${t('debug.pollRate')}</label>
          <select id="debug-poll-rate">
            <option value="10" ${selected(state.debugPollRateHz, 10)}>10 Hz</option>
            <option value="20" ${selected(state.debugPollRateHz, 20)}>20 Hz</option>
            <option value="50" ${selected(state.debugPollRateHz, 50)}>50 Hz</option>
          </select>
        </div>
        <div class="actions">
          <button class="primary" type="button" data-action="debug-start" ${state.debugPolling ? 'disabled' : ''}>${t('action.startPolling')}</button>
          <button class="secondary" type="button" data-action="debug-stop" ${state.debugPolling ? '' : 'disabled'}>${t('action.stop')}</button>
        </div>
        <div id="debug-error" class="notice" style="display:${state.debugError ? 'block' : 'none'}">${escapeHtml(state.debugError)}</div>
      </section>
      <section class="panel">
        <h2>${t('debug.headingAttitude')}</h2>
        <div class="metric"><span>${t('flight.roll')}</span><strong id="debug-roll">${formatDebugValue(sample?.roll_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('flight.pitch')}</span><strong id="debug-pitch">${formatDebugValue(sample?.pitch_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('flight.yaw')}</span><strong id="debug-yaw">${formatDebugValue(sample?.yaw_deg, 2, ' deg')}</strong></div>
      </section>
      <section class="panel debug-aircraft-panel">
        <h2>${t('debug.headingAircraft')}</h2>
        <div id="debug-aircraft-wrapper" class="debug-aircraft-wrapper">
          <canvas id="debug-aircraft-canvas" aria-label="${t('debug.canvasLabel')}"></canvas>
        </div>
      </section>
    </div>
    ${renderPidLog()}
  </div>`;
}

const pidRateSeries = [
  ['rateRollTarget', 'Roll target', '#2563eb'], ['rateRollState', 'Roll state', '#60a5fa'],
  ['ratePitchTarget', 'Pitch target', '#dc2626'], ['ratePitchState', 'Pitch state', '#f87171'],
  ['rateYawTarget', 'Yaw target', '#16a34a'], ['rateYawState', 'Yaw state', '#4ade80'],
];
const pidAngleSeries = [
  ['angleRollTarget', 'Roll target', '#7c3aed'], ['angleRollState', 'Roll state', '#a78bfa'],
  ['anglePitchTarget', 'Pitch target', '#ea580c'], ['anglePitchState', 'Pitch state', '#fb923c'],
];

function pidChartDefinitions() {
  if (state.pidLogMode === 'angle') {
    return [
      {key: 'angle', title: t('pidlog.angleChart'), unit: 'deg', series: pidAngleSeries},
    ];
  }
  return [
    {key: 'rate', title: t('pidlog.rateChart'), unit: 'deg/s', series: pidRateSeries},
  ];
}

function pidSamplesForDisplay() {
  // MSP polling is explicitly started by the user. Keep every returned sample
  // so waveform playback no longer depends on the CH6 flight-mode position.
  return state.pidLogSamples;
}

function pidChartView(key) {
  if (!state.pidChartViews[key]) state.pidChartViews[key] = {endUs: null, followLatest: true};
  return state.pidChartViews[key];
}

function renderPidLegend(series) {
  return `<div class="pid-series">${series.map(([key, label, color]) => `<label><input type="checkbox" data-pid-series="${key}" ${state.pidLogVisible[key] === false ? '' : 'checked'}><span style="--series-color:${color}"></span>${label}</label>`).join('')}</div>`;
}

function renderPidLog() {
  return `<div class="pid-log-layout">
    <section class="panel">
      <div class="panel-heading"><div><h2>${t('pidlog.heading')}</h2><div class="helper">${t('pidlog.description')}</div></div></div>
      <div class="actions"><button class="primary" type="button" data-action="pidlive-${state.pidLiveReceiving ? 'stop' : 'start'}" ${state.pidLiveStarting ? 'disabled' : ''}>${state.pidLiveStarting ? t('pidlog.connecting') : state.pidLiveReceiving ? t('pidlog.stop') : t('pidlog.start')}</button><button class="secondary" type="button" data-action="pidlive-clear">${t('pidlog.clear')}</button><button class="secondary" type="button" data-action="pidlive-save" ${state.pidLogSamples.length ? '' : 'disabled'}>${t('pidlog.save')}</button></div>
      ${state.pidLogError ? `<div class="message error">${escapeHtml(state.pidLogError)}</div>` : ''}
      <div class="metrics"><div class="metric"><span>${t('pidlog.pollRate')}</span><strong id="pid-live-rate">${state.pidLiveRateHz.toFixed(1)} Hz</strong></div><div class="metric"><span>${t('pidlog.points')}</span><strong id="pid-live-packets">${state.pidLivePackets.toLocaleString()}</strong></div><div class="metric"><span>${t('pidlog.duplicates')}</span><strong id="pid-live-duplicates">${state.pidLiveDuplicates.toLocaleString()}</strong></div></div>
      <div class="pid-time-controls">
        <label>${t('pidlog.window')} <select id="pid-live-window">${![0, 5, 10, 30].includes(state.pidLiveWindowSeconds) ? `<option value="${state.pidLiveWindowSeconds}" selected>${state.pidLiveWindowSeconds.toFixed(2)} s</option>` : ''}<option value="5" ${state.pidLiveWindowSeconds === 5 ? 'selected' : ''}>5 s</option><option value="10" ${state.pidLiveWindowSeconds === 10 ? 'selected' : ''}>10 s</option><option value="30" ${state.pidLiveWindowSeconds === 30 ? 'selected' : ''}>30 s</option><option value="0" ${state.pidLiveWindowSeconds === 0 ? 'selected' : ''}>${t('pidlog.all')}</option></select></label>
        <span id="pid-window-label">${state.pidLiveWindowSeconds ? `${state.pidLiveWindowSeconds.toFixed(2)} s` : t('pidlog.all')}</span>
      </div>
      <div class="helper">${t('pidlog.chartHelp')}</div>
    </section>
    <section class="panel pid-chart-panel">
      <div class="panel-heading"><div><h2><span class="live-pulse" aria-hidden="true"></span>${t('pidlog.liveHeading')}</h2><div class="helper">${t('pidlog.liveHelp')}</div></div><span class="live-caption">LIVE DATA</span></div>
      <div class="pid-mode-tabs"><button type="button" data-pid-mode="rate" class="${state.pidLogMode === 'rate' ? 'active' : ''}">${t('pidlog.rateTab')}</button><button type="button" data-pid-mode="angle" class="${state.pidLogMode === 'angle' ? 'active' : ''}">${t('pidlog.angleTab')}</button></div>
      <div class="pid-chart-heading"><h3>${state.pidLogMode === 'angle' ? t('pidlog.angleLoop') : t('pidlog.rateLoop')}</h3>${renderPidLegend(state.pidLogMode === 'angle' ? pidAngleSeries : pidRateSeries)}</div>
      <div class="pid-axis-charts">${pidChartDefinitions().map((chart) => `<div class="pid-chart-block" data-pid-chart-block="${chart.key}"><div class="pid-axis-title"><h3>${chart.title}</h3><span>${chart.unit}</span></div><canvas data-pid-chart="${chart.key}"></canvas><div class="pid-chart-timeline"><span>${t('pidlog.history')}</span><input data-pid-timeline="${chart.key}" type="range" min="0" max="1000" step="1" value="1000"><button class="secondary" type="button" data-pid-latest="${chart.key}">${t('pidlog.latest')}</button></div></div>`).join('')}</div>
    </section>
  </div>`;
}

function drawPidChart(canvas, samples, chart) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, canvas.clientWidth);
  const height = Math.max(240, canvas.clientHeight);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const visible = chart.series.filter(([key]) => state.pidLogVisible[key] !== false);
  ctx.fillStyle = '#f2eee6'; ctx.fillRect(0, 0, width, height);
  if (samples.length < 2) {
    ctx.fillStyle = '#625b53'; ctx.font = '13px sans-serif';
    ctx.fillText(state.pidLogMode === 'angle' ? t('pidlog.waitingAngle') : t('pidlog.waitingRate'), 18, 30);
    return;
  }
  if (!visible.length) return;
  let minY = Infinity; let maxY = -Infinity;
  for (const sample of samples) for (const [key] of visible) { minY = Math.min(minY, sample[key]); maxY = Math.max(maxY, sample[key]); }
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const pad = Math.max(1, (maxY - minY) * 0.08); minY -= pad; maxY += pad;
  const left = 54; const top = 15; const right = 12; const bottom = 30;
  const t0 = samples[0].timeUs; const span = Math.max(1, samples[samples.length - 1].timeUs - t0);
  ctx.strokeStyle = '#c5b7a3'; ctx.lineWidth = 1; ctx.strokeRect(left, top, width - left - right, height - top - bottom);
  ctx.fillStyle = '#625b53'; ctx.font = '12px sans-serif'; ctx.fillText(maxY.toFixed(1), 4, top + 5); ctx.fillText(minY.toFixed(1), 4, height - bottom);
  for (const [key, , color] of visible) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.25;
    samples.forEach((sample, index) => {
      const x = left + ((sample.timeUs - t0) / span) * (width - left - right);
      const y = top + ((maxY - sample[key]) / (maxY - minY)) * (height - top - bottom);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  const hover = state.pidChartHover[chart.key];
  if (hover && samples.length) {
    const plotWidth = width - left - right;
    const ratio = Math.max(0, Math.min(1, (hover.x - left) / Math.max(1, plotWidth)));
    const targetUs = t0 + ratio * span;
    let nearest = samples[0];
    for (const sample of samples) {
      if (Math.abs(sample.timeUs - targetUs) < Math.abs(nearest.timeUs - targetUs)) nearest = sample;
    }
    const pointX = left + ((nearest.timeUs - t0) / span) * plotWidth;
    ctx.save();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#8f806d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pointX, top); ctx.lineTo(pointX, height - bottom); ctx.stroke(); ctx.setLineDash([]);
    const lines = [`${t('pidlog.time')}  ${((nearest.timeUs - t0) / 1e6).toFixed(3)} s`, ...visible.map(([key, label]) => `${label}  ${Number(nearest[key]).toFixed(2)} ${chart.unit}`)];
    ctx.font = '12px sans-serif';
    const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 22;
    const boxHeight = lines.length * 19 + 12;
    const boxX = hover.x < width / 2 ? width - right - boxWidth - 8 : left + 8;
    const boxY = hover.y < height / 2 ? height - bottom - boxHeight - 8 : top + 8;
    ctx.fillStyle = 'rgba(69, 61, 52, 0.94)';
    ctx.beginPath(); ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 7); ctx.fill();
    lines.forEach((line, index) => { ctx.fillStyle = index ? visible[index - 1][2] : '#e2e8f0'; ctx.fillText(line, boxX + 11, boxY + 18 + index * 19); });
    for (const [key, , color] of visible) {
      const pointY = top + ((maxY - nearest[key]) / (maxY - minY)) * (height - top - bottom);
      ctx.beginPath(); ctx.fillStyle = color; ctx.arc(pointX, pointY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  }
}

function updatePidLiveView(redraw = true) {
  const values = {
    'pid-live-rate': `${state.pidLiveRateHz.toFixed(1)} Hz`,
    'pid-live-packets': state.pidLivePackets.toLocaleString(),
    'pid-live-duplicates': state.pidLiveDuplicates.toLocaleString(),
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  const saveButton = document.querySelector('[data-action="pidlive-save"]');
  if (saveButton) saveButton.disabled = state.pidLogSamples.length === 0;
  if (redraw) drawPidCharts();
}

function drawPidCharts() {
  const allModeSamples = pidSamplesForDisplay();
  const label = document.querySelector('#pid-window-label');
  if (label) label.textContent = state.pidLiveWindowSeconds ? `${state.pidLiveWindowSeconds.toFixed(2)} s` : t('pidlog.all');
  for (const chart of pidChartDefinitions()) {
    const view = pidChartView(chart.key);
    let samples = allModeSamples;
    let timelineValue = 1000;
    if (state.pidLiveWindowSeconds && allModeSamples.length) {
      const firstUs = allModeSamples[0].timeUs;
      const latestUs = allModeSamples[allModeSamples.length - 1].timeUs;
      const windowUs = state.pidLiveWindowSeconds * 1e6;
      const earliestEndUs = Math.min(latestUs, firstUs + windowUs);
      if (view.followLatest || view.endUs === null) view.endUs = latestUs;
      view.endUs = Math.max(earliestEndUs, Math.min(latestUs, view.endUs));
      samples = allModeSamples.filter((sample) => sample.timeUs >= view.endUs - windowUs && sample.timeUs <= view.endUs);
      timelineValue = latestUs === earliestEndUs ? 1000 : Math.round((view.endUs - earliestEndUs) / (latestUs - earliestEndUs) * 1000);
    }
    const timeline = document.querySelector(`[data-pid-timeline="${chart.key}"]`);
    if (timeline) { timeline.value = timelineValue; timeline.disabled = !state.pidLiveWindowSeconds || allModeSamples.length < 2; }
    const latestButton = document.querySelector(`[data-pid-latest="${chart.key}"]`);
    if (latestButton) latestButton.disabled = view.followLatest;
    drawPidChart(document.querySelector(`[data-pid-chart="${chart.key}"]`), samples, chart);
  }
}

function zoomPidTimeline(event) {
  if (!state.pidLogSamples.length) return;
  event.preventDefault();
  const samples = pidSamplesForDisplay();
  if (samples.length < 2) return;
  const fullSeconds = Math.max(0.05, (samples[samples.length - 1].timeUs - samples[0].timeUs) / 1e6);
  const currentSeconds = state.pidLiveWindowSeconds || fullSeconds;
  const latestUs = samples[samples.length - 1].timeUs;
  const oldWindowUs = currentSeconds * 1e6;
  const key = event.currentTarget.dataset.pidChart;
  const view = pidChartView(key);
  const oldEndUs = view.followLatest || view.endUs === null ? latestUs : view.endUs;
  const rect = event.currentTarget.getBoundingClientRect();
  const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const anchorUs = oldEndUs - oldWindowUs + anchor * oldWindowUs;
  state.pidLiveWindowSeconds = Math.max(0.05, Math.min(fullSeconds, currentSeconds * Math.exp(event.deltaY * 0.001)));
  const newWindowUs = state.pidLiveWindowSeconds * 1e6;
  const earliestEndUs = Math.min(latestUs, samples[0].timeUs + newWindowUs);
  view.endUs = Math.max(earliestEndUs, Math.min(latestUs, anchorUs + (1 - anchor) * newWindowUs));
  view.followLatest = Math.abs(view.endUs - latestUs) < 1;
  drawPidCharts();
}

function seekPidTimeline(key, value) {
  const samples = pidSamplesForDisplay();
  if (!samples.length || !state.pidLiveWindowSeconds) return;
  const firstUs = samples[0].timeUs;
  const latestUs = samples[samples.length - 1].timeUs;
  const earliestEndUs = Math.min(latestUs, firstUs + state.pidLiveWindowSeconds * 1e6);
  const view = pidChartView(key);
  view.endUs = earliestEndUs + (latestUs - earliestEndUs) * Number(value) / 1000;
  view.followLatest = Number(value) >= 1000;
  drawPidCharts();
}

function hoverPidChart(event) {
  const key = event.currentTarget.dataset.pidChart;
  const rect = event.currentTarget.getBoundingClientRect();
  state.pidChartHover[key] = {x: event.clientX - rect.left, y: event.clientY - rect.top};
  drawPidCharts();
}

function leavePidChart(event) {
  delete state.pidChartHover[event.currentTarget.dataset.pidChart];
  drawPidCharts();
}

function capturePidPollSample(sample) {
  if (!state.pidLiveReceiving || !sample) return;
  const timestampMs = Number(sample.timestamp_ms);
  if (!Number.isFinite(timestampMs)) return;
  if (state.pidLiveLastSequence === timestampMs) {
    state.pidLiveDuplicates += 1;
    updatePidLiveView(false);
    return;
  }

  state.pidLiveLastSequence = timestampMs;
  state.pidLivePackets += 1;
  state.pidLogSamples.push({
    sequence: state.pidLivePackets,
    timeUs: timestampMs * 1000,
    timestampMs,
    mode: Number(sample.mode),
    loopTimeUs: Number(sample.loop_time_us),
    armed: Boolean(sample.armed),
    angleRollTarget: Number(sample.angle_roll_target),
    anglePitchTarget: Number(sample.angle_pitch_target),
    angleRollState: Number(sample.roll_deg),
    anglePitchState: Number(sample.pitch_deg),
    rateRollTarget: Number(sample.rate_roll_target),
    ratePitchTarget: Number(sample.rate_pitch_target),
    rateYawTarget: Number(sample.rate_yaw_target),
    rateRollState: Number(sample.gyro_x_dps),
    ratePitchState: Number(sample.gyro_y_dps),
    rateYawState: Number(sample.gyro_z_dps),
  });
  const now = performance.now();
  pidLiveRateWindow.push(now);
  pidLiveRateWindow = pidLiveRateWindow.filter((time) => now - time <= 1000);
  state.pidLiveRateHz = pidLiveRateWindow.length;
  updatePidLiveView(true);
}

async function startPidLive() {
  if (state.pidLiveReceiving) return;
  if (!state.debugPolling) state.debugSample = null;
  state.pidLiveReceiving = true;
  state.pidLiveStarting = true;
  state.pidLogError = '';
  render();
  try {
    await ensureMspDebugConnection();
    await pollDebugOnce();
    scheduleDebugPoll();
  } catch (error) {
    state.pidLiveReceiving = false;
    state.pidLogError = error.message || String(error);
  }
  state.pidLiveStarting = false;
  render();
}

async function stopPidLive() {
  state.pidLiveReceiving = false;
  state.pidLiveStarting = false;
  await stopMspDebugConnectionIfIdle();
  render();
}

function clearPidLive() {
  state.pidLogSamples = []; state.pidLivePackets = 0; state.pidLiveDuplicates = 0;
  state.pidLiveLastSequence = null; state.pidLiveRateHz = 0; state.pidChartViews = {}; state.pidChartHover = {};
  pidLiveRateWindow = []; render();
}

async function savePidLive() {
  const keys = ['timestampMs','sequence','mode','loopTimeUs','armed','angleRollTarget','angleRollState','anglePitchTarget','anglePitchState','rateRollTarget','rateRollState','ratePitchTarget','ratePitchState','rateYawTarget','rateYawState'];
  const csv = [keys.join(','), ...state.pidLogSamples.map((sample) => keys.map((key) => sample[key]).join(','))].join('\n');
  try {
    const path = await saveBlob(
      new Blob(['\uFEFF', csv], {type: 'text/csv;charset=utf-8'}),
      `glrs-pid-live-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
      [{name: 'CSV', extensions: ['csv']}],
    );
    if (path) state.message = {type: 'ok', text: t('pidlog.saveSuccess')};
  } catch (error) {
    state.message = {type: 'error', text: `${t('pidlog.saveFailed')}: ${error.message || String(error)}`};
  }
  render();
}

function updateDebugView() {
  const sample = state.debugSample;
  const fields = {
    'debug-roll': formatDebugValue(sample?.roll_deg, 2, ' deg'),
    'debug-pitch': formatDebugValue(sample?.pitch_deg, 2, ' deg'),
    'debug-yaw': formatDebugValue(sample?.yaw_deg, 2, ' deg'),
  };
  Object.entries(fields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  const errorElement = document.getElementById('debug-error');
  if (errorElement) {
    errorElement.textContent = state.debugError || '';
    errorElement.style.display = state.debugError ? 'block' : 'none';
  }
  updateDebugAircraftAttitude(sample);
}

function renderHardwareJson() {
  return `
    <section class="panel">
      <h2>${t('hardware.heading')}</h2>
      <form id="hardware-form">
        <div class="row"><label for="hardware_json">${t('hardware.params')}</label><textarea class="json" id="hardware_json" name="hardware_json">${escapeHtml(jsonText(hardware()))}</textarea></div>
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="danger" type="button" data-action="reset-hardware">${t('action.resetHardware')}</button></div>
      </form>
    </section>`;
}

function renderWifi() {
  const networkOptions = state.networks.map((network) => `<option value="${escapeHtml(network)}"></option>`).join('');
  return `
    <div class="grid">
      <section class="panel">
        <h2>${t('wifi.homeNetwork')}</h2>
        <form id="wifi-form">
          <div class="row"><label for="network">${t('wifi.ssid')}</label><input id="network" name="network" list="networks"><datalist id="networks">${networkOptions}</datalist></div>
          <div class="row"><label for="password">${t('wifi.password')}</label><input id="password" name="password" type="password"></div>
          <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.saveConnect')}</button><button class="secondary" type="button" data-action="scan">${t('action.scan')}</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>${t('wifi.wifiMode')}</h2>
        <div class="actions"><button class="secondary" type="button" data-action="connect">${t('action.connectHome')}</button><button class="secondary" type="button" data-action="access-point">${t('action.accessPoint')}</button><button class="danger" type="button" data-action="forget">${t('action.forget')}</button></div>
      </section>
    </div>`;
}

function renderUpdate() {
  const mismatch = state.uploadResult?.status === 'mismatch';
  const uploadProgress = state.uploadProgress;
  const uploadError = state.uploadResult && state.uploadResult.status !== 'ok'
    ? `<div class="notice">${escapeHtml(state.uploadResult.msg || t('update.failed', {status: state.uploadResult.status || t('value.unknown')}))}</div>`
    : '';
  const progressPercent = uploadProgress?.total ? Math.max(0, Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))) : 0;
  const appUpdate = state.appUpdate;
  const appProgressPercent = appUpdate.total ? Math.max(0, Math.min(100, Math.round((appUpdate.downloaded / appUpdate.total) * 100))) : 0;
  const appStatus = t(`appUpdate.status.${appUpdate.status}`, {
    current: appUpdate.currentVersion,
    version: appUpdate.version,
  });
  const firmwareUpdate = state.firmwareUpdate;
  const firmwareProgressPercent = firmwareUpdate.total ? Math.max(0, Math.min(100, Math.round((firmwareUpdate.downloaded / firmwareUpdate.total) * 100))) : 0;
  const firmwareStatus = t(`firmwareUpdate.status.${firmwareUpdate.status}`, {
    current: firmwareUpdate.currentVersion,
    latest: firmwareUpdate.latestVersion,
    filename: firmwareUpdate.filename,
  });
  return `
    <div class="grid">
      <section class="panel">
        <h2>${t('appUpdate.heading')}</h2>
        <p class="helper">${t('appUpdate.description')}</p>
        <div class="row">
          <label for="app-update-source">${t('appUpdate.source')}</label>
          <select id="app-update-source" ${['checking', 'downloading', 'permission', 'installing', 'installed'].includes(appUpdate.status) ? 'disabled' : ''}>
            <option value="gitee" ${state.updateSource === 'gitee' ? 'selected' : ''}>${t('appUpdate.sourceGitee')}</option>
            <option value="github" ${state.updateSource === 'github' ? 'selected' : ''}>${t('appUpdate.sourceGithub')}</option>
          </select>
        </div>
        <div class="notice app-update-status">${escapeHtml(appStatus)}</div>
        ${appUpdate.error ? `<div class="message error">${escapeHtml(appUpdate.error)}</div>` : ''}
        ${appUpdate.notes ? `<div class="app-update-notes">${escapeHtml(appUpdate.notes)}</div>` : ''}
        ${appUpdate.status === 'downloading' ? `<div class="upload-progress"><div class="upload-progress-meta"><span>${t('appUpdate.downloading')}</span><strong>${appProgressPercent}%</strong></div><div class="upload-progress-bar"><span style="width:${appProgressPercent}%"></span></div></div>` : ''}
        <div class="actions">
          <button class="secondary" type="button" data-action="app-update-check" ${['checking', 'downloading', 'permission', 'installing', 'installed'].includes(appUpdate.status) ? 'disabled' : ''}>${t('action.checkUpdate')}</button>
          ${['available', 'permission'].includes(appUpdate.status) ? `<button class="primary" type="button" data-action="app-update-install">${t(appUpdate.status === 'permission' ? 'action.continueInstall' : 'action.installUpdate')}</button>` : ''}
        </div>
      </section>
      <section class="panel">
        <h2>${t('update.heading')}</h2>
        <p class="helper">${t('firmwareUpdate.description')}</p>
        <div class="row">
          <label for="firmware-update-source">${t('appUpdate.source')}</label>
          <select id="firmware-update-source" ${['checking', 'downloading'].includes(firmwareUpdate.status) ? 'disabled' : ''}>
            <option value="gitee" ${state.updateSource === 'gitee' ? 'selected' : ''}>${t('appUpdate.sourceGitee')}</option>
            <option value="github" ${state.updateSource === 'github' ? 'selected' : ''}>${t('appUpdate.sourceGithub')}</option>
          </select>
        </div>
        <div class="notice app-update-status">${escapeHtml(firmwareStatus)}</div>
        ${firmwareUpdate.error ? `<div class="message error">${escapeHtml(firmwareUpdate.error)}</div>` : ''}
        ${firmwareUpdate.latestVersion ? `<div class="firmware-release-version"><span>${t('firmwareUpdate.latestVersion')}</span><strong>${escapeHtml(firmwareUpdate.latestVersion)}</strong></div>` : ''}
        ${firmwareUpdate.notes ? `<div class="firmware-release-notes"><strong>${t('firmwareUpdate.releaseNotes')}</strong><div class="app-update-notes">${escapeHtml(firmwareUpdate.notes)}</div></div>` : ''}
        ${firmwareUpdate.path ? `<div class="app-update-notes">${escapeHtml(t('firmwareUpdate.savedTo', {path: firmwareUpdate.path}))}</div>` : ''}
        ${firmwareUpdate.status === 'downloaded' ? `<p class="helper">${t('firmwareUpdate.directFlashHint')}</p>` : ''}
        ${firmwareUpdate.status === 'downloading' ? `<div class="upload-progress"><div class="upload-progress-meta"><span>${t('firmwareUpdate.downloading')}</span><strong>${firmwareProgressPercent}%</strong></div><div class="upload-progress-bar"><span style="width:${firmwareProgressPercent}%"></span></div></div>` : ''}
        <div class="actions">
          <button class="secondary" type="button" data-action="firmware-update-check" ${['checking', 'downloading'].includes(firmwareUpdate.status) ? 'disabled' : ''}>${t('action.checkFirmwareUpdate')}</button>
          ${['available', 'availableUnconnected'].includes(firmwareUpdate.status) ? `<button class="primary" type="button" data-action="firmware-update-download">${t('action.downloadLatestFirmware')}</button>` : ''}
          ${firmwareUpdate.status === 'downloaded' && state.target && firmwareUpdate.compatible !== false ? `<button class="primary" type="button" data-action="firmware-update-flash">${t('action.flashDownloadedFirmware')}</button>` : ''}
        </div>
        <hr>
        ${uploadError}
        <form id="update-form">
          <div class="row"><label for="firmware">${t('update.firmwareFile')}</label><input id="firmware" name="firmware" type="file"></div>
          ${uploadProgress ? `<div class="upload-progress"><div class="upload-progress-meta"><span>${escapeHtml(uploadProgress.phase)}</span><strong>${progressPercent}%</strong></div><div class="upload-progress-bar"><span style="width:${progressPercent}%"></span></div></div>` : ''}
          <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.upload')}</button><button class="secondary" type="button" data-action="firmware-current-download">${t('action.download')}</button>${mismatch ? `<button class="danger" type="button" data-action="force-confirm">${t('action.flashAnyway')}</button><button class="secondary" type="button" data-action="force-cancel">${t('action.cancel')}</button>` : ''}</div>
        </form>
      </section>
    </div>`;
}

function renderCurrentTab() {
  return {
    status: renderStatus,
    runtime: renderRuntime,
    model: renderModel,
    pwm: renderPwm,
    flight: renderFlight,
    debug: renderDebug,
    hardware: renderHardwareJson,
    wifi: renderWifi,
    update: renderUpdate,
  }[state.tab]();
}

function wirePwmForm() {
  const form = document.querySelector('#pwm-form');
  if (!form) return;

  const rows = pwmEntries().map((entry, index) => ({entry, index}));
  const wifiOutputToggle = form.elements.pwm_output_wifi_enabled;

  function runtimeValuesFromForm() {
    return rows.map(({index}) =>
      intOrDefault(form.elements[`pwm-runtime-${index}`]?.value, pwmOutputWifiValues()[index]));
  }

  function syncRuntimeControls() {
    const enabled = Boolean(wifiOutputToggle?.checked);
    rows.forEach(({index}) => {
      const slider = form.elements[`pwm-runtime-${index}`];
      const mode = intOrDefault(form.elements[`pwm-mode-${index}`]?.value, 0);
      if (slider) slider.disabled = !enabled || mode > 5;
    });
  }

  async function setWifiOutputEnabled() {
    if (!wifiOutputToggle) return;
    const enabled = wifiOutputToggle.checked;
    if (pwmRuntimeUpdateTimer) {
      window.clearTimeout(pwmRuntimeUpdateTimer);
      pwmRuntimeUpdateTimer = null;
      pwmRuntimePendingValues = null;
    }
    if (enabled) {
      rows.forEach(({index}) => {
        const center = intOrDefault(
          form.elements[`pwm-limit-center-${index}`]?.value,
          pwmOutputLimits()[index][1],
        );
        const slider = form.elements[`pwm-runtime-${index}`];
        if (slider) slider.value = String(center);
        const output = form.querySelector(`[data-pwm-runtime-value="${index}"]`);
        if (output) output.textContent = `${center} us`;
      });
    }
    wifiOutputToggle.disabled = true;
    syncRuntimeControls();
    try {
      const values = runtimeValuesFromForm();
      await apiFetch('/pwm-output', {
        method: 'POST',
        body: JSON.stringify({enabled, values}),
      });
      config().fc_pwm_output_wifi_enabled = enabled;
      config().fc_pwm_output_wifi_values = values;
    } catch (error) {
      wifiOutputToggle.checked = !enabled;
      setMessage('error', error.message || String(error));
      return;
    } finally {
      wifiOutputToggle.disabled = false;
      syncRuntimeControls();
    }
  }

  function scheduleRuntimeOutputUpdate() {
    const values = runtimeValuesFromForm();
    config().fc_pwm_output_wifi_values = values;
    pwmRuntimePendingValues = values;
    if (pwmRuntimeUpdateTimer || pwmRuntimeUpdateInFlight) return;
    pwmRuntimeUpdateTimer = window.setTimeout(flushRuntimeOutputUpdate, 50);
  }

  async function flushRuntimeOutputUpdate() {
    pwmRuntimeUpdateTimer = null;
    if (pwmRuntimeUpdateInFlight || !pwmRuntimePendingValues) return;
    const values = pwmRuntimePendingValues;
    pwmRuntimePendingValues = null;
    pwmRuntimeUpdateInFlight = true;
    try {
      await apiFetch('/pwm-output', {
        method: 'POST',
        body: JSON.stringify({values}),
        timeout: 2000,
      });
    } catch (error) {
      pwmRuntimePendingValues = null;
      setMessage('error', error.message || String(error));
    } finally {
      pwmRuntimeUpdateInFlight = false;
      if (pwmRuntimePendingValues && !pwmRuntimeUpdateTimer) {
        pwmRuntimeUpdateTimer = window.setTimeout(flushRuntimeOutputUpdate, 50);
      }
    }
  }

  function syncExclusiveOptions() {
    const selectedModes = new Map();
    rows.forEach(({index}) => {
      const modeInput = form.elements[`pwm-mode-${index}`];
      if (!modeInput) return;
      const mode = intOrDefault(modeInput.value, 0);
      if (mode > 9) selectedModes.set(mode, index);
    });

    rows.forEach(({index}) => {
      const modeInput = form.elements[`pwm-mode-${index}`];
      if (!modeInput) return;
      Array.from(modeInput.options).forEach((option) => {
        const mode = intOrDefault(option.value, -1);
        const owner = selectedModes.get(mode);
        option.disabled = mode > 9 && owner !== undefined && owner !== index;
      });
    });
  }

  function syncRow(index) {
    const modeInput = form.elements[`pwm-mode-${index}`];
    const sourceInput = form.elements[`pwm-source-${index}`];
    const failsafeModeInput = form.elements[`pwm-failsafe-mode-${index}`];
    const failsafeInput = form.elements[`pwm-failsafe-${index}`];
    const polarityInput = form.elements[`pwm-polarity-${index}`];
    if (!modeInput || !failsafeModeInput || !failsafeInput) return;
    const mode = intOrDefault(modeInput.value, 0);
    const mixerMode = sourceInput ? intOrDefault(sourceInput.value, 0) === 1 : false;
    const serialMode = mode > 9;
    form.querySelectorAll(`[data-pwm-dependent="${index}"]`).forEach((input) => {
      if (input === failsafeInput) return;
      const isInputCh = input.name && input.name.startsWith(`pwm-input-`);
      input.disabled = serialMode || (mixerMode && isInputCh);
    });
    if (polarityInput) polarityInput.disabled = false;
    failsafeInput.disabled = serialMode || intOrDefault(failsafeModeInput.value, 0) !== 0;
    form.querySelectorAll(`[data-pwm-limit="${index}"]`).forEach((input) => {
      input.disabled = mode > 5;
    });
  }

  function syncSerial2Visibility() {
    const row = document.querySelector('#serial1-config-row');
    if (!row) return;
    const visible = rows.some(({index}) => intOrDefault(form.elements[`pwm-mode-${index}`]?.value, 0) === 14);
    row.style.display = visible ? 'grid' : 'none';
  }

  rows.forEach(({index}) => {
    form.elements[`pwm-mode-${index}`]?.addEventListener('change', () => {
      syncExclusiveOptions();
      syncRow(index);
      syncRuntimeControls();
      syncSerial2Visibility();
    });
    form.elements[`pwm-failsafe-mode-${index}`]?.addEventListener('change', () => {
      syncRow(index);
    });
    form.elements[`pwm-source-${index}`]?.addEventListener('change', () => {
      syncRow(index);
    });
    syncRow(index);
    const runtimeSlider = form.elements[`pwm-runtime-${index}`];
    runtimeSlider?.addEventListener('input', () => {
      const value = intOrDefault(runtimeSlider.value, 1500);
      const output = form.querySelector(`[data-pwm-runtime-value="${index}"]`);
      if (output) output.textContent = `${value} us`;
      scheduleRuntimeOutputUpdate();
    });
  });

  wifiOutputToggle?.addEventListener('change', setWifiOutputEnabled);
  syncExclusiveOptions();
  syncRuntimeControls();
  syncSerial2Visibility();
}

function mspPollingActive() {
  return state.debugPolling || state.pidLiveReceiving;
}

async function ensureMspDebugConnection() {
  if (mspDebugConnected) return;
  if (!mspDebugConnectPromise) {
    mspDebugConnectPromise = tauriInvoke('msp_debug_connect', {apiBase: state.apiBase})
      .then(() => { mspDebugConnected = true; })
      .finally(() => { mspDebugConnectPromise = null; });
  }
  await mspDebugConnectPromise;
}

async function pollDebugOnce() {
  if (debugPollInFlight) return;
  const generation = debugPollGeneration;
  debugPollInFlight = true;
  try {
    if (state.debugPolling) {
      try {
        const imuSample = await tauriInvoke('msp_attitude_poll');
        if (generation !== debugPollGeneration || !state.debugPolling) return;
        if (imuSample) {
          state.debugSample = imuSample;
          state.debugError = '';
          updateDebugView();
        }
      } catch (error) {
        if (generation === debugPollGeneration && state.debugPolling) {
          state.debugError = error.message || String(error);
          updateDebugView();
        }
      }
    }
    if (state.pidLiveReceiving) {
      try {
        const pidSample = await tauriInvoke('msp_pid_poll');
        if (generation !== debugPollGeneration || !state.pidLiveReceiving) return;
        if (pidSample) {
          state.pidLogError = '';
          capturePidPollSample(pidSample);
        }
      } catch (error) {
        if (generation === debugPollGeneration && state.pidLiveReceiving) {
          state.pidLogError = error.message || String(error);
        }
      }
    }
  } finally {
    debugPollInFlight = false;
  }
}

function scheduleDebugPoll() {
  if (!mspPollingActive() || debugPollTimer) return;
  const intervalMs = Math.max(20, Math.round(1000 / state.debugPollRateHz));
  debugPollTimer = window.setTimeout(async () => {
    debugPollTimer = null;
    await pollDebugOnce();
    scheduleDebugPoll();
  }, intervalMs);
}

async function startDebugPolling() {
  state.debugPollRateHz = intOrDefault(document.querySelector('#debug-poll-rate')?.value, 20);
  state.debugError = '';
  state.debugPolling = true;
  render();
  try {
    await ensureMspDebugConnection();
    debugPollGeneration += 1;
    await pollDebugOnce();
    scheduleDebugPoll();
    return true;
  } catch (error) {
    state.debugPolling = false;
    state.debugError = error.message || String(error);
    render();
    return false;
  }
}

async function stopDebugPolling(disconnect = true) {
  state.debugPolling = false;
  await stopMspDebugConnectionIfIdle(disconnect);
  render();
}

async function stopMspDebugConnectionIfIdle(disconnect = true) {
  if (mspPollingActive()) return;
  debugPollGeneration += 1;
  if (debugPollTimer) {
    window.clearTimeout(debugPollTimer);
    debugPollTimer = null;
  }
  if (disconnect && mspDebugConnected) {
    try {
      await tauriInvoke('msp_debug_disconnect');
    } catch {
      // Browser preview has no Tauri backend.
    } finally {
      mspDebugConnected = false;
    }
  }
}

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand"><h1>${t('app.title')}</h1></div>
        <label class="beginner-mode-toggle" title="${escapeHtml(t('app.beginnerModeHelp'))}">
          <input type="checkbox" data-beginner-mode ${checked(state.beginnerMode)}>
          <span>${t('app.beginnerMode')}</span>
        </label>
        <div class="connection-status is-${state.connectionStatus}" title="${escapeHtml(apiBaseHost())}"><span></span><strong>${escapeHtml(connectionStatusLabel())}</strong></div>
        <select class="lang-switch" aria-label="${t('lang.label')}">
          <option value="zh-CN" ${selected(getLocale(), 'zh-CN')}>${t('lang.chinese')}</option>
          <option value="en" ${selected(getLocale(), 'en')}>${t('lang.english')}</option>
        </select>
        <form class="connection" id="connect-form">
          <input name="api" value="${escapeHtml(apiBaseHost())}" aria-label="API base URL">
          <button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.connect')}</button>
          <button class="secondary" type="button" data-action="refresh" ${state.busy ? 'disabled' : ''}>${t('action.refresh')}</button>
        </form>
      </header>
      <div class="shell">
        <nav class="nav">${tabs.map(([id, getLabel]) => `<button type="button" data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${getLabel()}</button>`).join('')}</nav>
        <main class="content">
          ${state.message ? `<div class="message ${state.message.type}">${escapeHtml(state.message.text)}</div>` : ''}
          ${state.busy ? `<div class="notice">${t('notice.working')}</div>` : ''}
          ${renderCurrentTab()}
        </main>
      </div>
    </div>`;
  wireEvents();
}

function wireEvents() {
  document.querySelector('[data-beginner-mode]')?.addEventListener('change', (event) => {
    state.beginnerMode = event.target.checked;
    localStorage.setItem(BEGINNER_MODE_STORAGE_KEY, state.beginnerMode ? '1' : '0');
    render();
  });

  document.querySelector('.lang-switch')?.addEventListener('change', (event) => {
    setLocale(event.target.value);
    if (!localStorage.getItem(UPDATE_SOURCE_STORAGE_KEY)) state.updateSource = defaultUpdateSource();
    document.title = t('app.title');
    render();
  });

  const updateSourceChanged = (event) => {
    state.updateSource = event.target.value;
    localStorage.setItem(UPDATE_SOURCE_STORAGE_KEY, state.updateSource);
    state.appUpdate = {...state.appUpdate, status: 'idle', version: '', notes: '', error: ''};
    state.firmwareUpdate = {...state.firmwareUpdate, status: 'idle', latestVersion: '', notes: '', productName: '', target: '', filename: '', path: '', error: ''};
    render();
  };
  document.querySelector('#app-update-source')?.addEventListener('change', updateSourceChanged);
  document.querySelector('#firmware-update-source')?.addEventListener('change', updateSourceChanged);

  document.querySelector('#connect-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.apiBase = normalizeApiBase(new FormData(event.currentTarget).get('api'));
    localStorage.setItem(API_STORAGE_KEY, state.apiBase);
    void connectDevice(t('message.connected'));
  });

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      state.message = null;
      render();
    });
  });

  document.querySelectorAll('[data-pid-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.pidLogMode = button.dataset.pidMode;
      state.pidChartHover = {};
      render();
    });
  });
  document.querySelectorAll('[data-pid-series]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      state.pidLogVisible[checkbox.dataset.pidSeries] = checkbox.checked;
      drawPidCharts();
    });
  });
  document.querySelector('#pid-live-window')?.addEventListener('change', (event) => {
    state.pidLiveWindowSeconds = Number(event.target.value);
    Object.values(state.pidChartViews).forEach((view) => { view.followLatest = true; view.endUs = null; });
    drawPidCharts();
  });
  document.querySelectorAll('[data-pid-chart]').forEach((canvas) => {
    canvas.addEventListener('wheel', zoomPidTimeline, {passive: false});
    canvas.addEventListener('pointermove', hoverPidChart);
    canvas.addEventListener('pointerleave', leavePidChart);
  });
  document.querySelectorAll('[data-pid-timeline]').forEach((timeline) => {
    timeline.addEventListener('input', () => seekPidTimeline(timeline.dataset.pidTimeline, timeline.value));
  });
  document.querySelectorAll('[data-pid-latest]').forEach((button) => {
    button.addEventListener('click', () => {
      const view = pidChartView(button.dataset.pidLatest);
      view.followLatest = true; view.endUs = null; drawPidCharts();
    });
  });

  document.querySelector('#runtime-form')?.addEventListener('submit', saveRuntime);
  document.querySelector('#model-form')?.addEventListener('submit', saveModel);
  document.querySelector('#pwm-form')?.addEventListener('submit', savePwm);
  document.querySelector('#flight-form')?.addEventListener('submit', saveFlight);
  document.querySelectorAll('[data-beginner-sensitivity]').forEach((input) => {
    input.addEventListener('input', () => {
      const output = document.querySelector(`[data-beginner-sensitivity-output="${input.dataset.beginnerSensitivity}"]`);
      if (output) output.textContent = t('flight.beginnerSensitivityValue', {level: input.value, value: beginnerSensitivityGain(input.value).toFixed(1)});
    });
  });
  document.querySelector('#hardware-form')?.addEventListener('submit', saveHardwareJson);
  document.querySelector('#wifi-form')?.addEventListener('submit', saveHomeNetwork);
  document.querySelector('#update-form')?.addEventListener('submit', uploadFirmware);
  document.querySelector('#profile-file')?.addEventListener('change', async (event) => {
    try {
      await importProfileFile(event.target.files?.[0]);
    } catch (error) {
      setMessage('error', error.message || String(error));
    }
  });
  document.querySelector('#community-profile-file')?.addEventListener('change', async (event) => {
    const errorBox = document.querySelector('.submission-error');
    try {
      if (errorBox) errorBox.textContent = '';
      await selectCommunityProfile(event.target.files?.[0]);
    } catch (error) {
      state.communitySubmission.profile = null;
      state.communitySubmission.fileName = '';
      if (errorBox) errorBox.textContent = error.message || String(error);
      event.target.value = '';
    }
  });
  document.querySelector('#community-submission-form')?.addEventListener('submit', submitCommunityProfile);
  document.querySelector('#community-catalog-search')?.addEventListener('input', (event) => {
    state.communityCatalog.query = event.target.value;
    updateCommunityCatalogResults();
  });
  document.querySelector('#community-catalog-vehicle')?.addEventListener('change', (event) => {
    state.communityCatalog.vehicleType = event.target.value;
    updateCommunityCatalogResults();
  });
  wireCommunityProfileActions();

  const phraseInput = document.querySelector('#phrase');
  const vbindInput = document.querySelector('#vbind');
  const modelMatchInput = document.querySelector('#model-match');
  const modelIdInput = document.querySelector('#modelid');
  const bindphraseRow = document.querySelector('#bindphrase-row');
  const uidRow = document.querySelector('#uid-row');
  const modelidRow = document.querySelector('#modelid-row');

  if (phraseInput) {
    phraseInput.addEventListener('input', (event) => {
      state.bindingPhrase = event.target.value;
      syncBindingPreview();
    });
  }

  if (vbindInput) {
    vbindInput.addEventListener('change', () => {
      const hidden = vbindInput.value === '1';
      if (bindphraseRow) bindphraseRow.style.display = hidden ? 'none' : 'grid';
      if (uidRow) uidRow.style.display = hidden ? 'none' : 'grid';
    });
    vbindInput.dispatchEvent(new Event('change'));
  }

  if (modelMatchInput && modelIdInput && modelidRow) {
    const syncModelId = () => {
      const enabled = modelMatchInput.checked;
      modelidRow.style.display = enabled ? 'grid' : 'none';
      if (!enabled) modelIdInput.value = '255';
      else if (modelIdInput.value === '255') modelIdInput.value = '';
    };
    modelMatchInput.addEventListener('change', syncModelId);
    syncModelId();
  }

  wireModeRangeEditors();

  const gyroBiasModeInputs = document.querySelectorAll('input[name="fc_gyro_bias_mode"]');
  const gyroCalibrateButton = document.querySelector('[data-action="gyro-calibrate"]');
  const gyroCalibrationAction = document.querySelector('[data-gyro-calibration-action]');
  const gyroBiasResults = document.querySelector('[data-gyro-bias-results]');
  const syncGyroCalibrationAvailability = () => {
    const autoCalibrationSelected = document.querySelector('input[name="fc_gyro_bias_mode"][value="1"]')?.checked;
    if (gyroCalibrateButton) {
      gyroCalibrateButton.disabled = Boolean(autoCalibrationSelected || state.busy || state.imuCalibration.busy || state.orientationCal.busy);
    }
    if (gyroCalibrationAction) gyroCalibrationAction.style.display = autoCalibrationSelected ? 'none' : 'flex';
    if (gyroBiasResults) gyroBiasResults.style.display = autoCalibrationSelected ? 'none' : 'grid';
  };
  gyroBiasModeInputs.forEach((input) => input.addEventListener('change', syncGyroCalibrationAvailability));
  syncGyroCalibrationAvailability();

  syncBindingPreview();
  wirePwmForm();
  initDebugAircraftView();
  initOrientationAircraftView();
  drawPidCharts();

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'refresh') void connectDevice(t('message.refreshed'));
      if (action === 'reboot') void rebootDevice();
      if (action === 'reset-model') postPlain('/reset?model', t('message.modelReset'));
      if (action === 'reset-hardware') postPlain('/reset?hardware', t('message.hardwareReset'));
      if (action === 'scan') scanNetworks();
      if (action === 'connect') postPlain('/connect', t('message.connectingHome'));
      if (action === 'access-point') postPlain('/access', t('message.switchingAp'));
      if (action === 'forget') postPlain('/forget', t('message.networkForgotten'));
      if (action === 'add-motor') changeMixerRowCount(1);
      if (action === 'remove-motor') changeMixerRowCount(-1);
      if (action === 'orientation-next') void captureOrientationFace();
      if (action === 'orientation-reset') resetOrientationCalibration();
      if (action === 'accel-next') void captureCurrentAccelFace();
      if (action === 'accel-reset') resetAccelCalibration();
      if (action === 'gyro-calibrate') void calibrateGyro();
      if (action === 'debug-start') startDebugPolling();
      if (action === 'debug-stop') stopDebugPolling();
      if (action === 'pidlive-start') void startPidLive();
      if (action === 'pidlive-stop') void stopPidLive().then(render);
      if (action === 'pidlive-clear') clearPidLive();
      if (action === 'pidlive-save') void savePidLive();
      if (action === 'force-confirm') forceUpdate('confirm');
      if (action === 'force-cancel') forceUpdate('cancel');
      if (action === 'app-update-check') checkAppUpdate();
      if (action === 'app-update-install') installAppUpdate();
      if (action === 'firmware-update-check') checkFirmwareUpdate();
      if (action === 'firmware-update-download') downloadFirmwareUpdate();
      if (action === 'firmware-current-download') downloadCurrentFirmware();
      if (action === 'firmware-update-flash') flashDownloadedFirmware();
      if (action === 'profile-export') exportProfile();
      if (action === 'profile-import') document.querySelector('#profile-file')?.click();
      if (action === 'profile-discard') discardProfileDraft();
      if (action === 'community-catalog-open') openCommunityCatalog();
      if (action === 'community-catalog-close') closeCommunityCatalog();
      if (action === 'community-catalog-refresh') void loadCommunityCatalog();
      if (action === 'community-submit') openCommunitySubmission();
      if (action === 'community-close') closeCommunitySubmission();
    });
  });
}

function wireModeRangeEditors() {
  const syncCard = (card, source = '') => {
    const startSlider = card.querySelector('[data-range-handle="start"]');
    const endSlider = card.querySelector('[data-range-handle="end"]');
    const startNumber = card.querySelector('[data-range-number="start"]');
    const endNumber = card.querySelector('[data-range-number="end"]');
    if (!startSlider || !endSlider || !startNumber || !endNumber) return;

    if (source === 'number-start' && startNumber.value !== '') startSlider.value = startNumber.value;
    if (source === 'number-end' && endNumber.value !== '') endSlider.value = endNumber.value;

    let start = clamp(intOrDefault(startSlider.value, 900), 900, 2075);
    let end = clamp(intOrDefault(endSlider.value, 2100), 925, 2100);
    if (start > end - 25) {
      if (source.includes('start')) start = end - 25;
      else end = start + 25;
    }

    startSlider.value = String(start);
    endSlider.value = String(end);
    startNumber.value = String(start);
    endNumber.value = String(end);
    card.style.setProperty('--range-start', `${((start - 900) / 1200) * 100}%`);
    card.style.setProperty('--range-end', `${((end - 900) / 1200) * 100}%`);
  };

  document.querySelectorAll('[data-mode-range]').forEach((card) => {
    const modeToggle = card.querySelector('[data-mode-enabled]');
    if (modeToggle) {
      const syncMode = () => {
        const disabled = !modeToggle.checked;
        card.classList.toggle('is-disabled', disabled);
        card.querySelectorAll('select, [data-range-handle], [data-range-number]').forEach((input) => {
          input.disabled = disabled;
        });
        if (modeToggle.name === 'fc_angle_enabled') {
          document.querySelectorAll('[data-angle-setting]').forEach((setting) => {
            setting.style.setProperty('display', disabled ? 'none' : 'block');
            setting.querySelectorAll('input, select, button').forEach((input) => { input.disabled = disabled; });
          });
          document.querySelectorAll('[data-angle-calibration]').forEach((calibration) => {
            calibration.hidden = disabled;
          });
        }
      };
      modeToggle.addEventListener('change', syncMode);
      syncMode();
    }
    card.querySelectorAll('[data-range-handle]').forEach((input) => {
      input.addEventListener('input', () => syncCard(card, `slider-${input.dataset.rangeHandle}`));
    });
    card.querySelectorAll('[data-range-number]').forEach((input) => {
      input.addEventListener('change', () => syncCard(card, `number-${input.dataset.rangeNumber}`));
    });

    const fill = card.querySelector('[data-range-fill]');
    const startSlider = card.querySelector('[data-range-handle="start"]');
    const endSlider = card.querySelector('[data-range-handle="end"]');
    if (fill && startSlider && endSlider) {
      fill.addEventListener('pointerdown', (event) => {
        if (startSlider.disabled || endSlider.disabled) return;
        event.preventDefault();
        const initialX = event.clientX;
        const initialStart = Number(startSlider.value);
        const initialEnd = Number(endSlider.value);
        const width = initialEnd - initialStart;
        const trackWidth = fill.parentElement.getBoundingClientRect().width;
        fill.setPointerCapture(event.pointerId);
        fill.classList.add('is-dragging');

        const moveRange = (moveEvent) => {
          const rawDelta = ((moveEvent.clientX - initialX) / trackWidth) * 1200;
          const delta = Math.round(rawDelta / 25) * 25;
          const nextStart = clamp(initialStart + delta, 900, 2100 - width);
          startSlider.value = String(nextStart);
          endSlider.value = String(nextStart + width);
          syncCard(card);
        };
        const stopDragging = () => {
          fill.classList.remove('is-dragging');
          fill.removeEventListener('pointermove', moveRange);
          fill.removeEventListener('pointerup', stopDragging);
          fill.removeEventListener('pointercancel', stopDragging);
        };

        fill.addEventListener('pointermove', moveRange);
        fill.addEventListener('pointerup', stopDragging);
        fill.addEventListener('pointercancel', stopDragging);
      });
    }
    syncCard(card);
  });

  const armToggle = document.querySelector('#fc_arm_enabled');
  const armConfig = document.querySelector('#arm-mode-config');
  if (armToggle && armConfig) {
    const syncArm = () => {
      const disabled = !armToggle.checked;
      armConfig.classList.toggle('is-disabled', disabled);
      armConfig.querySelector('[data-mode-range]')?.classList.toggle('is-disabled', disabled);
      armConfig.querySelectorAll('select, [data-range-handle], [data-range-number]').forEach((input) => {
        input.disabled = disabled;
      });
    };
    armToggle.addEventListener('change', syncArm);
    syncArm();
  }
}

document.title = t('app.title');
window.addEventListener('beforeunload', (event) => {
  if (!state.profileDraft) return;
  event.preventDefault();
  event.returnValue = '';
});
render();
async function initializeApp() {
  scheduleConnectionHealthCheck();
  await restoreDownloadedFirmware();
  await connectDevice(t('message.connected'));
  if (isTauriApp()) checkAppUpdate();
}
initializeApp();
