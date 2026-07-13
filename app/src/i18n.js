import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

const LOCALE_STORAGE_KEY = 'elrs-locale';
const DEFAULT_LOCALE = 'zh-CN';

const messages = {en, 'zh-CN': zhCN};

let currentLocale = loadLocale();

function loadLocale() {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && messages[stored]) return stored;
  return DEFAULT_LOCALE;
}

function resolve(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export function t(key, params) {
  let text = resolve(messages[currentLocale], key) || resolve(messages.en, key) || key;

  if (params) {
    Object.entries(params).forEach(([name, value]) => {
      text = text.replaceAll(`{${name}}`, String(value ?? ''));
    });
  }

  return text;
}

export function setLocale(locale) {
  if (!messages[locale]) return;
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function getLocale() {
  return currentLocale;
}

export {LOCALE_STORAGE_KEY};
