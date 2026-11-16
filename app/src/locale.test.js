import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLocale, localizedProfileTitle} from './locale.js';

test('first launch follows system language, including regional variants', () => {
  for (const language of ['zh-CN', 'zh-TW', 'zh-Hant-HK']) {
    assert.equal(resolveLocale(null, [language]), 'zh-CN');
  }
  for (const language of ['en', 'en-US', 'en-GB']) {
    assert.equal(resolveLocale(null, [language]), 'en');
  }
  assert.equal(resolveLocale(null, ['fr-FR', 'zh-CN', 'en']), 'zh-CN');
  assert.equal(resolveLocale(null, ['en-US', 'zh-CN']), 'en');
  assert.equal(resolveLocale(null, ['de-DE']), 'en');
  assert.equal(resolveLocale(null, []), 'en');
});

test('manual selection survives restart and takes priority over system language', () => {
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('invalid', ['en-US']), 'en');
});

test('profile names switch language and remain compatible with old catalogs', () => {
  const item = {title: '三通道固定翼', titleEn: 'Three-channel fixed-wing aircraft'};
  assert.equal(localizedProfileTitle(item, 'en'), item.titleEn);
  assert.equal(localizedProfileTitle(item, 'zh-CN'), item.title);
  for (const titleEn of [undefined, '', '  ', 42]) {
    assert.equal(localizedProfileTitle({...item, titleEn}, 'en'), item.title);
  }
});
