// The first-run theme: light for new installs, while a phone already in use that never picked a theme keeps the
// dark one it was showing (decided once, so a later sign-in never switches a fresh install to dark).
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleThemeDefault, startsDark, THEME_KEY, THEME_SETTLED } from '../src/appearance.js';

const store = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
};

test('a new install starts on the light theme, even after signing in later', () => {
  const storage = store();
  settleThemeDefault(storage, { signedIn: false, phone: true });
  assert.equal(startsDark(storage), false);
  settleThemeDefault(storage, { signedIn: true, phone: true });
  assert.equal(startsDark(storage), false);
  assert.equal(storage.getItem(THEME_SETTLED), '1');
});

test('a phone already signed in keeps the dark theme it had by default; a computer keeps light', () => {
  const phone = store();
  settleThemeDefault(phone, { signedIn: true, phone: true });
  assert.equal(startsDark(phone), true);
  const computer = store();
  settleThemeDefault(computer, { signedIn: true, phone: false });
  assert.equal(startsDark(computer), false);
});

test('a chosen theme is never changed', () => {
  const light = store({ [THEME_KEY]: 'light' });
  settleThemeDefault(light, { signedIn: true, phone: true });
  assert.equal(startsDark(light), false);
  const dark = store({ [THEME_KEY]: 'dark' });
  settleThemeDefault(dark, { signedIn: false, phone: false });
  assert.equal(startsDark(dark), true);
});
