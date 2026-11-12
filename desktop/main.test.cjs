// The desktop window's rules, without starting Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_APP_URL, appUrl, staysInApp, permissionAllowed } = require('./config.cjs');

test('opens the live messenger unless a test server is given; never plain http on the internet', () => {
  assert.equal(appUrl({}), DEFAULT_APP_URL);
  assert.equal(appUrl({ HM_APP_URL: 'http://localhost:5173/app' }), 'http://localhost:5173/app');
  assert.throws(() => appUrl({ HM_APP_URL: 'http://example.com/app' }), /https/);
});

test('only the messenger stays in the window; other links go to the browser', () => {
  assert.equal(staysInApp('https://hiddenmessenger.com/app/chat', DEFAULT_APP_URL), true);
  assert.equal(staysInApp('https://example.com/', DEFAULT_APP_URL), false);
  assert.equal(staysInApp('not a url', DEFAULT_APP_URL), false);
});

test('calls and notifications are allowed for the messenger only; nothing else is', () => {
  assert.equal(permissionAllowed('media', 'https://hiddenmessenger.com/app', DEFAULT_APP_URL), true);
  assert.equal(permissionAllowed('notifications', 'https://hiddenmessenger.com/', DEFAULT_APP_URL), true);
  assert.equal(permissionAllowed('geolocation', 'https://hiddenmessenger.com/app', DEFAULT_APP_URL), false);
  assert.equal(permissionAllowed('media', 'https://example.com/', DEFAULT_APP_URL), false);
});
