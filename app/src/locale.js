export function resolveLocale(stored, languages = []) {
  if (stored === 'en' || stored === 'zh-CN') return stored;
  for (const language of languages) {
    const base = String(language).toLowerCase().split(/[-_]/)[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function localizedProfileTitle(item, locale) {
  return locale === 'en' && typeof item.titleEn === 'string' && item.titleEn.trim()
    ? item.titleEn
    : item.title;
}
