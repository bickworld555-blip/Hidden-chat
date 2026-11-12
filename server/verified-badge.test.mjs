// The verified badge is a green circle with a white tick everywhere it shows, coloured per theme, and the contact info
// screen of a verified account says so under the name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the badge is a green circle with a white tick, named "Verified" for screen readers', async () => {
  const badge = await source('src/components/VerifiedBadge.jsx');
  assert.ok(badge.includes('role="img" aria-label="Verified"'));
  assert.ok(badge.includes(`<circle cx="12" cy="12" r="11" style={{ fill: 'var(--hm-verified, #0F9D4E)' }} />`));
  assert.ok(badge.includes('stroke="#fff"'));
  assert.doesNotMatch(badge, /linearGradient|#2563eb|#3b8cf6/i, 'no blue shield left');
});

test('its green is tuned for each theme, and no blue glow remains', async () => {
  const css = await source('src/styles.css');
  assert.ok(css.includes('.app-shell { --hm-verified: #0F9D4E; --hm-verified-text: #0B7A3B;'));
  assert.ok(css.includes('.app-shell.dark-theme { --hm-verified: #1DAA61; --hm-verified-text: #3DD37E;'));
  assert.ok(!css.includes('drop-shadow(0 0 1.5px #60a5fa66)'), 'the old blue glow is gone');
});

test('every place a verified name shows uses the one badge, the contacts list included', async () => {
  for (const file of ['src/components/ChatsList.jsx', 'src/components/ChatWindow.jsx', 'src/components/ContactInfoDrawer.jsx', 'src/components/SelectContactModal.jsx', 'src/components/ToolsView.jsx']) {
    assert.ok((await source(file)).includes('<VerifiedBadge size='), file);
  }
  const info = await source('src/components/ContactInfoDrawer.jsx');
  assert.ok(info.includes('className="wa-info-verified"') && info.includes('Verified Account'), 'the "Verified Account" line under the name');
  assert.ok(info.includes('className="wa-info-verified-note"'), 'the note under the actions');
});
