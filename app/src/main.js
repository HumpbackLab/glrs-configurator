import './styles.css';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import { t, setLocale, getLocale } from './i18n.js';

const DEFAULT_API = 'http://10.0.0.1';
const API_STORAGE_KEY = 'elrs-local-rx-api';
const LOCAL_PROXY_PATH = '/__elrs_proxy__';

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
  uploadResult: null,
  uploadProgress: null,
  extraMixerRows: 0,
  eulerRoll: 0,
  eulerPitch: 0,
  eulerYaw: 0,
  orientationCal: null,
  debugSample: null,
  debugError: '',
  debugPolling: false,
  debugPollRateHz: 20,
};

let debugPollTimer = null;
let debugPollInFlight = false;
let debugPollGeneration = 0;
let debugAircraftView = null;

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

function listToString(value) {
  return bytesToList(value).join(',');
}

function listToPrettyString(value) {
  return bytesToList(value).join(', ');
}

function isValidUidByte(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 && parsed < 256;
}

const md5 = (() => {
  const k = [];
  for (let i = 0; i < 64;) {
    k[i] = 0 | (Math.abs(Math.sin(++i)) * 4294967296);
  }

  function calcMD5(str) {
    let b;
    let c;
    let d;
    let j;
    const x = [];
    const str2 = unescape(encodeURI(str));
    let a = str2.length;
    const h = [b = 1732584193, c = -271733879, ~b, ~c];
    let i = 0;

    for (; i <= a;) x[i >> 2] |= (str2.charCodeAt(i) || 128) << 8 * (i++ % 4);

    str = (a + 8 >> 6) * 16 + 14;
    x[str] = a * 8;
    i = 0;

    for (; i < str; i += 16) {
      a = h; j = 0;
      for (; j < 64;) {
        a = [
          d = a[3],
          ((b = a[1] | 0) +
            ((d = (
              (a[0] +
                [
                  b & (c = a[2]) | ~b & d,
                  d & b | ~d & c,
                  b ^ c ^ d,
                  c ^ (b | ~d)
                ][a = j >> 4]
              ) +
              (k[j] +
                (x[[
                  j,
                  5 * j + 1,
                  3 * j + 5,
                  7 * j
                ][a] % 16 + i] | 0)
              )
            )) << (a = [
              7, 12, 17, 22,
              5, 9, 14, 20,
              4, 11, 16, 23,
              6, 10, 15, 21
            ][4 * a + j++ % 4]) | d >>> 32 - a)
          ),
          b,
          c
        ];
      }
      for (j = 4; j;) h[--j] = h[j] + a[j];
    }

    str = [];
    for (; j < 32;) str.push(((h[j >> 3] >> ((1 ^ j++ & 7) * 4)) & 15) * 16 + ((h[j >> 3] >> ((1 ^ j++ & 7) * 4)) & 15));

    return new Uint8Array(str);
  }
  return calcMD5;
})();

function formatNumberList(value, rowSize) {
  if (!Array.isArray(value)) return '';
  const rows = [];
  for (let i = 0; i < value.length; i += rowSize) {
    rows.push(value.slice(i, i + rowSize).join(', '));
  }
  return rows.join('\n');
}

function parseNumberList(value) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = trimmed.split(/[\s,]+/).filter(Boolean).map(Number);
  return parsed.some((item) => Number.isNaN(item)) ? null : parsed;
}

function pwmConnected() {
  return !!state.target;
}

function pwmEntries() {
  const raw = Array.isArray(config().pwm) ? config().pwm : [];
  if (raw.length > 0) return raw;
  // Offline fallback: 8 dummy channels with default 50Hz config for UI development
  if (!pwmConnected()) {
    const dummy = []; for (let i = 0; i < 8; i++) dummy.push({config: 0, pin: i + 2, features: 0});
    return dummy;
  }
  return [];
}

function pwmAvailable() {
  return pwmEntries().length > 0;
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

function renderNumGrid(prefix, rowLabels, colLabels, values, options = {}) {
  const disabled = options.disabled ? 'disabled' : '';
  const note = options.note ? `<div class="helper">${escapeHtml(options.note)}</div>` : '';
  return `
    <div class="table-shell">
      <table class="grid-table">
        <thead>
          <tr>
            <th>${escapeHtml(options.rowHeader || '')}</th>
            ${colLabels.map((label) => `<th>${escapeHtml(label)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rowLabels.map((rowLabel, rowIndex) => `
            <tr>
              <th scope="row">${escapeHtml(rowLabel)}</th>
              ${colLabels.map((_, colIndex) => {
                const index = rowIndex * colLabels.length + colIndex;
                return `<td><input type="number" step="any" inputmode="decimal" data-grid="${prefix}" data-row="${rowIndex}" data-col="${colIndex}" value="${escapeHtml(numCellValue(values, index))}" ${disabled}></td>`;
              }).join('')}
            </tr>`).join('')}
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

function validateArray(label, value, rowSize, exactLength) {
  if (value === undefined) return true;
  if (value === null) throw new Error(t('error.validateArrayInvalid', {label}));
  if (exactLength && value.length !== exactLength) throw new Error(t('error.validateArrayLength', {label, exactLength}));
  if (!exactLength && value.length % rowSize !== 0) throw new Error(t('error.validateArrayAlignment', {label, rowSize}));
  return true;
}

async function loadDevice() {
  const [target, configResponse, hardwareResponse] = await Promise.all([
    apiFetch('/target'),
    apiFetch('/config'),
    apiFetch('/hardware.json').catch(() => ({})),
  ]);
  state.target = target;
  state.configResponse = configResponse;
  state.hardware = hardwareResponse;
  state.extraMixerRows = 0;
  state.originalUid = bytesToList(configResponse?.config?.uid);
  state.originalUidType = configResponse?.config?.uidtype || '';
  const orient = (configResponse?.config?.fc_orientation || []).length === 9 ? configResponse.config.fc_orientation : [];
  const [roll, pitch, yaw] = installEulerFromOrientationMatrix(orient);
  state.eulerRoll = roll;
  state.eulerPitch = pitch;
  state.eulerYaw = yaw;
  if (!state.bindingPhrase) {
    state.bindingPhrase = '';
  }
}

function configValue(key, fallback) {
  const value = config()[key];
  return value === undefined ? fallback : value;
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
  const form = event.currentTarget;
  const entries = pwmEntries();
  const usedExclusiveModes = new Map();
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

  const payload = {
    ...config(),
    pwm: nextPwm,
    'serial1-protocol': pwmSerial2Active() ? configValue('serial1-protocol', 0) : 0,
  };

  const serial2Input = form.elements['serial1-protocol'];
  if (serial2Input) {
    payload['serial1-protocol'] = intOrDefault(serial2Input.value, 0);
  }

  await runBusy(async () => {
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(payload)});
    await loadDevice();
  }, t('message.pwmSaved'));
}

async function saveFlight(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const nextConfig = {...config()};
  await runBusy(async () => {
    nextConfig.fc_angle_enabled = form.fc_angle_enabled.checked;
    nextConfig.fc_arm_enabled = form.fc_arm_enabled.checked;
    nextConfig.fc_rate_pid = readNumGrid(form, 'fc_rate_pid', 3, 4);
    nextConfig.fc_angle_pid = readNumGrid(form, 'fc_angle_pid', 3, 4);
    nextConfig.fc_mixer = readNumGrid(form, 'fc_mixer', motorCount(), 4);
    nextConfig.fc_orientation = orientationMatrixFromInstallEuler(state.eulerRoll, state.eulerPitch, state.eulerYaw);
    delete nextConfig.pwm;
    await apiFetch('/config', {method: 'POST', body: JSON.stringify(nextConfig)});
    state.extraMixerRows = 0;
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

function nearestCardinalAxis(v) {
  const axis = [0, 0, 0];
  let best = 0;
  for (let i = 1; i < 3; i += 1) {
    if (Math.abs(v[i]) > Math.abs(v[best])) best = i;
  }
  axis[best] = v[best] >= 0 ? 1 : -1;
  return axis;
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

function normalizeCardinalAngle(degrees) {
  let value = Math.round(degrees / 90) * 90;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

async function sampleRawAccel(sampleCount = 24, delayMs = 40) {
  const sum = [0, 0, 0];
  let valid = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const status = await apiFetch('/status.json', {timeout: 2000});
    const imu = status?.imu || {};
    const accel = imu['accel-mps2'];
    if (imu['accel-valid'] && accel) {
      const x = Number(accel.x);
      const y = Number(accel.y);
      const z = Number(accel.z);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        sum[0] += x;
        sum[1] += y;
        sum[2] += z;
        valid += 1;
      }
    }
    if (i + 1 < sampleCount) await sleep(delayMs);
  }
  if (valid < Math.ceil(sampleCount * 0.75)) {
    throw new Error(t('error.notEnoughSamples'));
  }
  return normalizeVector(sum.map((value) => value / valid));
}

function orientationEulerFromSamples(levelRaw, forwardRaw) {
  // Firmware expects fc_orientation to rotate raw IMU axes into the internal frame.
  // Level gravity maps to internal +Z; nose-up gravity maps to internal +X.
  // The resulting matrix is therefore the firmware matrix, not the user-facing
  // physical install attitude. Convert it back before filling the UI controls.
  const rowZ = nearestCardinalAxis(levelRaw);
  const rowX = nearestCardinalAxis(forwardRaw);
  if (Math.abs(dotVector(rowX, rowZ)) > 0) {
    throw new Error(t('error.sameAxis'));
  }
  const rowY = crossVector(rowZ, rowX);
  const matrix = [...rowX, ...rowY, ...rowZ];
  const [roll, pitch, yaw] = installEulerFromOrientationMatrix(matrix).map(normalizeCardinalAngle);
  return {roll, pitch, yaw, matrix};
}

function orientationCalText() {
  if (state.orientationCal?.level) {
    return t('orient.instructionNoseUp');
  }
  return t('orient.instructionLevel');
}

function orientationCalButtonText() {
  if (state.orientationCal?.level) {
    return t('orient.sampleNoseUp');
  }
  return t('orient.sampleLevel');
}

function setEulerAngles(roll, pitch, yaw) {
  state.eulerRoll = roll;
  state.eulerPitch = pitch;
  state.eulerYaw = yaw;
}

async function quickOrientationStep() {
  await runBusy(async () => {
    if (!state.orientationCal?.level) {
      const level = await sampleRawAccel();
      state.orientationCal = {level};
      setMessage('ok', t('orient.levelCaptured'));
      return;
    }

    const forward = await sampleRawAccel();
    const result = orientationEulerFromSamples(state.orientationCal.level, forward);
    setEulerAngles(result.roll, result.pitch, result.yaw);
    state.orientationCal = null;
    setMessage('ok', t('orient.setResult', {roll: result.roll, pitch: result.pitch, yaw: result.yaw}));
  });
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
  await runBusy(async () => {
    await apiFetch(path, {method: 'POST', body: new FormData()});
  }, successText);
}

async function uploadFirmware(event) {
  event.preventDefault();
  const file = event.currentTarget.firmware.files[0];
  if (!file) {
    setMessage('error', t('message.selectFirmware'));
    return;
  }
  await runBusy(async () => {
    state.uploadProgress = {loaded: 0, total: file.size, phase: t('update.phase.uploading')};
    render();
    const form = new FormData();
    form.set('update[]', file, file.name);
    const result = await xhrRequest('/update', {
      method: 'POST',
      body: form,
      headers: {'X-FileSize': String(file.size)},
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

async function forceUpdate(action) {
  const form = new FormData();
  form.set('action', action);
  await runBusy(async () => {
    state.uploadResult = await xhrRequest('/forceupdate', {method: 'POST', body: form, timeout: 90000});
  }, action === 'confirm' ? t('message.forceConfirmed') : t('message.forceCancelled'));
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
    '/models/model_rudderless_plane.gltf',
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
  debugAircraftView.model.rotation.x = sample.pitch_deg * -DEG_TO_RAD;
  debugAircraftView.modelWrapper.rotation.y = sample.yaw_deg * -DEG_TO_RAD;
  debugAircraftView.model.rotation.z = sample.roll_deg * -DEG_TO_RAD;
  debugAircraftView.render();
}

function renderStatus() {
  const c = config();
  const h = hardware();
  return `
    <div class="grid">
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
        <div class="metric"><span>${t('status.flightAngleLoop')}</span><strong>${configValue('fc_angle_enabled', false) ? t('value.enabled') : t('value.disabled')}</strong></div>
        <div class="metric"><span>${t('status.ch5MotorArm')}</span><strong>${configValue('fc_arm_enabled', false) ? t('value.enabled') : t('value.disabled')}</strong></div>
      </section>
      <section class="panel">
        <h2>${t('status.sensors')}</h2>
        <div class="metric"><span>${t('status.gyro')}</span><strong>${state.target?.['has-gyro'] ? t('value.detected') : t('value.notDetected')}</strong>${state.target?.['gyro-msg'] ? `<div class="diag-msg">${escapeHtml(state.target['gyro-msg']).replace(/\n/g, '<br>')}</div>` : ''}</div>
        ${state.target?.['has-vbat'] ? `<div class="metric"><span>${t('status.vbat')}</span><strong>${(state.target['vbat-voltage'] * 0.01).toFixed(2)} V</strong></div>` : ''}
      </section>
    </div>`;
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
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="reboot">${t('action.reboot')}</button></div>
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
  const entries = pwmEntries();
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
                    <th scope="row">${index + 1}</th>
                    <td>${escapeHtml(entry.pin)}</td>
                    <td><div class="badge-row pwm-badges">${pwmFeatureBadges(entry.features)}</div></td>
                    <td><select name="pwm-mode-${index}" data-pwm-mode="${index}">${renderPwmModeOptions(entry.features, decoded.mode)}</select></td>
                    <td><select name="pwm-source-${index}" data-pwm-dependent="${index}"><option value="0" ${selected(decoded.mixerMode ? 1 : 0, 0)}>${t('pwm.sourceRc')}</option><option value="1" ${selected(decoded.mixerMode ? 1 : 0, 1)}>${t('pwm.sourceMixer')}</option></select></td>
                    <td><select name="pwm-input-${index}" data-pwm-dependent="${index}">${pwmInputLabels.map((label, value) => `<option value="${value}" ${selected(decoded.inputChannel, value)}>${label}</option>`).join('')}</select></td>
                    <td><input name="pwm-invert-${index}" type="checkbox" data-pwm-dependent="${index}" ${checked(decoded.inverted)} ${disabled(disabledRow)}></td>
                    <td><input name="pwm-polarity-${index}" type="checkbox" data-pwm-polarity="${index}" ${checked(decoded.signalPolarityInverted)}></td>
                    <td><input name="pwm-narrow-${index}" type="checkbox" data-pwm-dependent="${index}" ${checked(decoded.narrow)} ${disabled(disabledRow)}></td>
                    <td><select name="pwm-failsafe-mode-${index}" data-pwm-failsafe-mode="${index}" data-pwm-dependent="${index}" ${disabled(disabledRow)}>${pwmFailsafeModes.map((getLabel, value) => `<option value="${value}" ${selected(decoded.failsafeMode, value)}>${getLabel()}</option>`).join('')}</select></td>
                    <td><input name="pwm-failsafe-${index}" type="number" min="988" max="2011" value="${escapeHtml(decoded.failsafe)}" data-pwm-failsafe="${index}" data-pwm-dependent="${index}" ${disabled(failsafeDisabled)}></td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="row" id="serial1-config-row" style="display:${serial2Visible ? 'grid' : 'none'};">
          <label for="serial1-protocol">${t('pwm.serial2Protocol')}</label>
          <select id="serial1-protocol" name="serial1-protocol">${serial1Protocols.map(([value, label]) => `<option value="${value}" ${selected(configValue('serial1-protocol', 0), value)}>${label}</option>`).join('')}</select>
          <div class="helper">${t('pwm.help.serial2')}</div>
        </div>
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="refresh">${t('action.refresh')}</button></div>
      </form>
    </section>`;
}

function motorCount() {
  const mixerData = configValue('fc_mixer', []);
  const configCount = configValue('fc_mixer_count', 0);
  const base = configCount ? Math.floor(configCount / 4) : Math.max(1, Math.floor(mixerData.length / 4) || 1);
  return base + (state.extraMixerRows || 0);
}

function rad(deg) { return deg * Math.PI / 180; }
function deg(rad) { return rad * 180 / Math.PI; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

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
  return [Math.round(deg(roll)), Math.round(deg(pitch)), Math.round(deg(yaw))];
}

function matrixFromEuler(roll, pitch, yaw) {
  // Compute 3x3 rotation matrix (ZYX convention, flat row-major).
  const cr = Math.cos(rad(roll)), sr = Math.sin(rad(roll));
  const cp = Math.cos(rad(pitch)), sp = Math.sin(rad(pitch));
  const cy = Math.cos(rad(yaw)), sy = Math.sin(rad(yaw));
  return [
    round4(cy * cp),              round4(cy * sp * sr - sy * cr), round4(cy * sp * cr + sy * sr),
    round4(sy * cp),              round4(sy * sp * sr + cy * cr), round4(sy * sp * cr - cy * sr),
    round4(-sp),                  round4(cp * sr),                round4(cp * cr),
  ];
}

function transposeMatrix3(m) {
  if (!m || m.length < 9) return [];
  return [
    numCellValue(m, 0), numCellValue(m, 3), numCellValue(m, 6),
    numCellValue(m, 1), numCellValue(m, 4), numCellValue(m, 7),
    numCellValue(m, 2), numCellValue(m, 5), numCellValue(m, 8),
  ];
}

function orientationMatrixFromInstallEuler(roll, pitch, yaw) {
  // UI angles describe the physical board install attitude in the body frame.
  // Firmware fc_orientation has the opposite direction: raw IMU frame -> internal
  // body frame (+X forward, +Y left, +Z up). For pure rotation matrices the
  // inverse is the transpose, so the saved matrix is the inverse of the visible
  // install angle. Example: a physical yaw=90 install may save as yaw=-90.
  return transposeMatrix3(matrixFromEuler(roll, pitch, yaw)).map(round4);
}

function installEulerFromOrientationMatrix(m) {
  // Hardware JSON stores the firmware raw->internal matrix. Show users the
  // inverse because the UI labels are physical install roll/pitch/yaw.
  return eulerFromMatrix(transposeMatrix3(m));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function formatMatrixRow(row) {
  return row.map((v) => String(v).padStart(8)).join(' ');
}

function boardPreviewTransform(roll, pitch, yaw) {
  // The board graphic draws FlightControl +X forward as the on-screen FW arrow.
  // Map preview rotations onto that frame: roll about forward, pitch about left,
  // and yaw inverted for CSS' top-down screen rotation direction.
  return `rotateZ(${-yaw}deg) rotateY(${roll}deg) rotateX(${pitch}deg)`;
}

function renderFlight() {
  const motors = motorCount();
  const ratePid = configValue('fc_rate_pid', []);
  const anglePid = configValue('fc_angle_pid', []);
  const mixer = configValue('fc_mixer', []);
  const angleEnabled = configValue('fc_angle_enabled', false);
  const armEnabled = configValue('fc_arm_enabled', false);
  const roll = state.eulerRoll ?? 0;
  const pitch = state.eulerPitch ?? 0;
  const yaw = state.eulerYaw ?? 0;
  const matrix = orientationMatrixFromInstallEuler(roll, pitch, yaw);
  const matrixText = [
    formatMatrixRow(matrix.slice(0, 3)),
    formatMatrixRow(matrix.slice(3, 6)),
    formatMatrixRow(matrix.slice(6, 9)),
  ].join('\n');
  return `
    <section class="panel">
      <h2>${t('flight.heading')}</h2>
      <form id="flight-form">
        <div class="check"><input id="fc_angle_enabled" name="fc_angle_enabled" type="checkbox" ${checked(angleEnabled)}><label for="fc_angle_enabled">${t('flight.angleEnabled')}</label></div>
        <div class="check"><input id="fc_arm_enabled" name="fc_arm_enabled" type="checkbox" ${checked(armEnabled)}><label for="fc_arm_enabled">${t('flight.armEnabled')}</label></div>
        <div class="notice">${t('notice.rateLoop')}</div>
        <div class="row">
          <label>${t('flight.ratePid')}</label>
          ${renderNumGrid('fc_rate_pid', [t('flight.roll'), t('flight.pitch'), t('flight.yaw')], [t('flight.kp'), t('flight.ki'), t('flight.kd'), t('flight.iLimit')], ratePid, {rowHeader: t('flight.axis')})}
        </div>
        <div class="row" id="angle-pid-row" style="display:${angleEnabled ? 'grid' : 'none'};">
          <label>${t('flight.anglePid')}</label>
          ${renderNumGrid('fc_angle_pid', [t('flight.roll'), t('flight.pitch'), t('flight.yaw')], [t('flight.kp'), t('flight.ki'), t('flight.kd'), t('flight.iLimit')], anglePid, {rowHeader: t('flight.axis'), disabled: !angleEnabled})}
        </div>
        <div class="row">
          <label>${t('flight.mixer')}</label>
          ${renderNumGrid('fc_mixer', Array.from({length: motors}, (_, i) => `${t('flight.motor')} ${i + 1}`), [t('flight.throttle'), t('flight.roll'), t('flight.pitch'), t('flight.yaw')], mixer, {rowHeader: t('flight.motor')})}
          <div class="helper">${motors} ${motors !== 1 ? t('flight.motors') : t('flight.motor')}</div>
          <div class="actions">
            <button class="secondary" type="button" data-action="add-motor" ${state.busy ? 'disabled' : ''}>${t('action.addMotor')}</button>
            <button class="secondary" type="button" data-action="remove-motor" ${state.busy || state.extraMixerRows <= 0 ? 'disabled' : ''}>${t('action.removeMotor')}</button>
          </div>
        </div>
        <div class="row">
          <label>${t('flight.boardOrientation')}</label>
          <div class="orientation-editor">
            <div class="euler-controls">
              <div class="euler-field">
                <label for="euler-roll">${t('flight.roll')} <span class="axis-tag">X</span></label>
                <div class="euler-input-row">
                  <input type="range" id="euler-roll-slider" data-euler="roll" class="euler-slider" min="-180" max="180" value="${roll}">
                  <input type="number" id="euler-roll" data-euler="roll" class="euler-number" value="${roll}" step="1" min="-180" max="180">
                </div>
              </div>
              <div class="euler-field">
                <label for="euler-pitch">${t('flight.pitch')} <span class="axis-tag">Y</span></label>
                <div class="euler-input-row">
                  <input type="range" id="euler-pitch-slider" data-euler="pitch" class="euler-slider" min="-180" max="180" value="${pitch}">
                  <input type="number" id="euler-pitch" data-euler="pitch" class="euler-number" value="${pitch}" step="1" min="-180" max="180">
                </div>
              </div>
              <div class="euler-field">
                <label for="euler-yaw">${t('flight.yaw')} <span class="axis-tag">Z</span></label>
                <div class="euler-input-row">
                  <input type="range" id="euler-yaw-slider" data-euler="yaw" class="euler-slider" min="-180" max="180" value="${yaw}">
                  <input type="number" id="euler-yaw" data-euler="yaw" class="euler-number" value="${yaw}" step="1" min="-180" max="180">
                </div>
              </div>
            </div>
            <div class="preview-scene">
              <div class="preview-scene-inner">
                <div class="preview-board" id="board-preview" style="transform:${boardPreviewTransform(roll, pitch, yaw)}">
                  <div class="board-top">
                    <div class="board-chip">▲</div>
                    <div class="board-label">${t('flight.boardLabel')}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="matrix-display">${escapeHtml(matrixText)}</div>
            <div class="helper">${escapeHtml(orientationCalText())}</div>
            <div class="actions">
              <button class="secondary" type="button" data-action="quick-orientation" ${state.busy ? 'disabled' : ''}>${escapeHtml(orientationCalButtonText())}</button>
            </div>
          </div>
        </div>
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.save')}</button><button class="secondary" type="button" data-action="reboot">${t('action.reboot')}</button></div>
      </form>
    </section>`;
}

function renderDebug() {
  const sample = state.debugSample;
  const attitudeErrorRoll = sample ? sample.roll_deg - sample.accel_roll_deg : NaN;
  const attitudeErrorPitch = sample ? sample.pitch_deg - sample.accel_pitch_deg : NaN;
  return `
    <div class="grid">
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
        <div class="helper">${t('debug.help.polling')}</div>
      </section>
      <section class="panel">
        <h2>${t('debug.headingAttitude')}</h2>
        <div class="metric"><span>${t('flight.roll')}</span><strong id="debug-roll">${formatDebugValue(sample?.roll_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('flight.pitch')}</span><strong id="debug-pitch">${formatDebugValue(sample?.pitch_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('flight.yaw')}</span><strong id="debug-yaw">${formatDebugValue(sample?.yaw_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('debug.accelRollRef')}</span><strong id="debug-accel-roll">${formatDebugValue(sample?.accel_roll_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('debug.accelPitchRef')}</span><strong id="debug-accel-pitch">${formatDebugValue(sample?.accel_pitch_deg, 2, ' deg')}</strong></div>
        <div class="metric"><span>${t('debug.rollPitchError')}</span><strong id="debug-error-angle">${formatDebugValue(attitudeErrorRoll, 2, ' deg')} / ${formatDebugValue(attitudeErrorPitch, 2, ' deg')}</strong></div>
      </section>
      <section class="panel debug-aircraft-panel">
        <h2>${t('debug.headingAircraft')}</h2>
        <div id="debug-aircraft-wrapper" class="debug-aircraft-wrapper">
          <canvas id="debug-aircraft-canvas" aria-label="${t('debug.canvasLabel')}"></canvas>
        </div>
      </section>
    </div>`;
}

function updateDebugView() {
  const sample = state.debugSample;
  const fields = {
    'debug-roll': formatDebugValue(sample?.roll_deg, 2, ' deg'),
    'debug-pitch': formatDebugValue(sample?.pitch_deg, 2, ' deg'),
    'debug-yaw': formatDebugValue(sample?.yaw_deg, 2, ' deg'),
    'debug-accel-roll': formatDebugValue(sample?.accel_roll_deg, 2, ' deg'),
    'debug-accel-pitch': formatDebugValue(sample?.accel_pitch_deg, 2, ' deg'),
    'debug-error-angle': `${formatDebugValue(sample ? sample.roll_deg - sample.accel_roll_deg : NaN, 2, ' deg')} / ${formatDebugValue(sample ? sample.pitch_deg - sample.accel_pitch_deg : NaN, 2, ' deg')}`,
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
  const firmwareHref = apiUrl('/firmware.bin');
  const mismatch = state.uploadResult?.status === 'mismatch';
  const uploadProgress = state.uploadProgress;
  const uploadError = state.uploadResult && state.uploadResult.status !== 'ok'
    ? `<div class="notice">${escapeHtml(state.uploadResult.msg || t('update.failed', {status: state.uploadResult.status || t('value.unknown')}))}</div>`
    : '';
  const progressPercent = uploadProgress?.total ? Math.max(0, Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))) : 0;
  return `
    <section class="panel">
      <h2>${t('update.heading')}</h2>
      ${uploadError}
      <form id="update-form">
        <div class="row"><label for="firmware">${t('update.firmwareFile')}</label><input id="firmware" name="firmware" type="file"></div>
        ${uploadProgress ? `<div class="upload-progress"><div class="upload-progress-meta"><span>${escapeHtml(uploadProgress.phase)}</span><strong>${progressPercent}%</strong></div><div class="upload-progress-bar"><span style="width:${progressPercent}%"></span></div></div>` : ''}
        <div class="actions"><button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.upload')}</button><a class="secondary button-link" href="${firmwareHref}">${t('action.download')}</a>${mismatch ? `<button class="danger" type="button" data-action="force-confirm">${t('action.flashAnyway')}</button><button class="secondary" type="button" data-action="force-cancel">${t('action.cancel')}</button>` : ''}</div>
      </form>
    </section>`;
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

function wireOrientationPreview() {
  const sliders = document.querySelectorAll('.euler-slider');
  const numbers = document.querySelectorAll('.euler-number');
  const board = document.querySelector('#board-preview');
  const matrixDisplay = document.querySelector('.matrix-display');
  if (!sliders.length || !board) return;

  function sync() {
    const roll = Number(document.querySelector('[data-euler="roll"].euler-number')?.value) || 0;
    const pitch = Number(document.querySelector('[data-euler="pitch"].euler-number')?.value) || 0;
    const yaw = Number(document.querySelector('[data-euler="yaw"].euler-number')?.value) || 0;
    state.eulerRoll = roll;
    state.eulerPitch = pitch;
    state.eulerYaw = yaw;
    board.style.transform = boardPreviewTransform(roll, pitch, yaw);
    if (matrixDisplay) {
      const m = orientationMatrixFromInstallEuler(roll, pitch, yaw);
      matrixDisplay.textContent = [
        formatMatrixRow(m.slice(0, 3)),
        formatMatrixRow(m.slice(3, 6)),
        formatMatrixRow(m.slice(6, 9)),
      ].join('\n');
    }
  }

  sliders.forEach((slider) => {
    slider.addEventListener('input', () => {
      const axis = slider.dataset.euler;
      const numInput = document.querySelector(`[data-euler="${axis}"].euler-number`);
      if (numInput) numInput.value = slider.value;
      sync();
    });
  });

  numbers.forEach((numInput) => {
    numInput.addEventListener('input', () => {
      const axis = numInput.dataset.euler;
      const slider = document.querySelector(`[data-euler="${axis}"].euler-slider`);
      if (slider) slider.value = numInput.value;
      sync();
    });
  });
}

function wirePwmForm() {
  const form = document.querySelector('#pwm-form');
  if (!form) return;

  const rows = pwmEntries().map((entry, index) => ({entry, index}));

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
      syncSerial2Visibility();
    });
    form.elements[`pwm-failsafe-mode-${index}`]?.addEventListener('change', () => {
      syncRow(index);
    });
    form.elements[`pwm-source-${index}`]?.addEventListener('change', () => {
      syncRow(index);
    });
    syncRow(index);
  });

  syncExclusiveOptions();
  syncSerial2Visibility();
}

async function pollDebugOnce() {
  if (debugPollInFlight) return;
  const generation = debugPollGeneration;
  debugPollInFlight = true;
  try {
    const sample = await tauriInvoke('msp_debug_poll');
    if (generation !== debugPollGeneration || !state.debugPolling) return;
    if (!sample) return;
    state.debugSample = sample;
    state.debugError = '';
    updateDebugView();
  } catch (error) {
    if (generation !== debugPollGeneration || !state.debugPolling) return;
    state.debugError = error.message || String(error);
    updateDebugView();
  } finally {
    debugPollInFlight = false;
  }
}

function scheduleDebugPoll() {
  if (!state.debugPolling || debugPollTimer) return;
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
  try {
    await tauriInvoke('msp_debug_connect', {apiBase: state.apiBase});
    debugPollGeneration += 1;
    state.debugPolling = true;
    render();
    await pollDebugOnce();
    scheduleDebugPoll();
  } catch (error) {
    state.debugPolling = false;
    state.debugError = error.message || String(error);
    render();
  }
}

async function stopDebugPolling(disconnect = true) {
  debugPollGeneration += 1;
  if (debugPollTimer) {
    window.clearTimeout(debugPollTimer);
    debugPollTimer = null;
  }
  state.debugPolling = false;
  render();
  if (disconnect) {
    try {
      await tauriInvoke('msp_debug_disconnect');
    } catch {
      // Browser preview has no Tauri backend.
    }
  }
}

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand"><h1>${t('app.title')}</h1><span>${t('app.subtitle')}</span></div>
        <select class="lang-switch" aria-label="${t('lang.label')}">
          <option value="zh-CN" ${selected(getLocale(), 'zh-CN')}>${t('lang.chinese')}</option>
          <option value="en" ${selected(getLocale(), 'en')}>${t('lang.english')}</option>
        </select>
        <form class="connection" id="connect-form">
          <input name="api" value="${escapeHtml(state.apiBase)}" aria-label="API base URL">
          <button class="primary" ${state.busy ? 'disabled' : ''}>${t('action.connect')}</button>
          <button class="secondary" type="button" data-action="refresh" ${state.busy ? 'disabled' : ''}>${t('action.refresh')}</button>
        </form>
      </header>
      <div class="status">
        <div class="metric"><span>API</span><strong>${escapeHtml(state.apiBase)}</strong></div>
        <div class="metric"><span>${t('status.target')}</span><strong>${escapeHtml(state.target?.['module-type'] || 'RX')}</strong></div>
        <div class="metric"><span>${t('status.rx')}</span><strong>${escapeHtml(state.target?.['radio-type'] || t('value.unknown'))}</strong></div>
      </div>
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
  document.querySelector('.lang-switch')?.addEventListener('change', (event) => {
    setLocale(event.target.value);
    document.title = t('app.title');
    render();
  });

  document.querySelector('#connect-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.apiBase = normalizeApiBase(new FormData(event.currentTarget).get('api'));
    localStorage.setItem(API_STORAGE_KEY, state.apiBase);
    runBusy(loadDevice, t('message.connected'));
  });

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      state.message = null;
      render();
    });
  });

  document.querySelector('#runtime-form')?.addEventListener('submit', saveRuntime);
  document.querySelector('#model-form')?.addEventListener('submit', saveModel);
  document.querySelector('#pwm-form')?.addEventListener('submit', savePwm);
  document.querySelector('#flight-form')?.addEventListener('submit', saveFlight);
  document.querySelector('#hardware-form')?.addEventListener('submit', saveHardwareJson);
  document.querySelector('#wifi-form')?.addEventListener('submit', saveHomeNetwork);
  document.querySelector('#update-form')?.addEventListener('submit', uploadFirmware);

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

  const anglePidRow = document.querySelector('#angle-pid-row');
  const angleEnabled = document.querySelector('#fc_angle_enabled');
  if (anglePidRow && angleEnabled) {
    const syncAnglePid = () => {
      const enabled = angleEnabled.checked;
      anglePidRow.style.display = enabled ? 'grid' : 'none';
      anglePidRow.querySelectorAll('input').forEach((input) => {
        input.disabled = !enabled;
      });
    };
    angleEnabled.addEventListener('change', syncAnglePid);
    syncAnglePid();
  }

  syncBindingPreview();
  wireOrientationPreview();
  wirePwmForm();
  initDebugAircraftView();

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'refresh') runBusy(loadDevice, t('message.refreshed'));
      if (action === 'reboot') postPlain('/reboot', t('message.rebootRequested'));
      if (action === 'reset-model') postPlain('/reset?model', t('message.modelReset'));
      if (action === 'reset-hardware') postPlain('/reset?hardware', t('message.hardwareReset'));
      if (action === 'scan') scanNetworks();
      if (action === 'connect') postPlain('/connect', t('message.connectingHome'));
      if (action === 'access-point') postPlain('/access', t('message.switchingAp'));
      if (action === 'forget') postPlain('/forget', t('message.networkForgotten'));
      if (action === 'add-motor') { state.extraMixerRows = (state.extraMixerRows || 0) + 1; render(); }
      if (action === 'remove-motor') { state.extraMixerRows = Math.max(0, (state.extraMixerRows || 0) - 1); render(); }
      if (action === 'quick-orientation') quickOrientationStep();
      if (action === 'debug-start') startDebugPolling();
      if (action === 'debug-stop') stopDebugPolling();
      if (action === 'force-confirm') forceUpdate('confirm');
      if (action === 'force-cancel') forceUpdate('cancel');
    });
  });
}

document.title = t('app.title');
render();
runBusy(loadDevice, t('message.connected'));
