// The website's Windows download links point at the files the release workflow attaches for the current version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WINDOWS_APP_VERSION, WINDOWS_INSTALLER_URL, WINDOWS_PORTABLE_URL } from '../src/site/links.js';

const desktop = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
const expand = (pattern) => pattern.replace('${version}', desktop.version).replace('${ext}', 'exe');

test('the Windows download links match the desktop app version and the names the build gives its files', () => {
  assert.equal(WINDOWS_APP_VERSION, desktop.version, 'raise both together');
  const release = `https://github.com/bickworld555-blip/Hidden-chat/releases/download/desktop-v${desktop.version}/`;
  assert.equal(WINDOWS_INSTALLER_URL, release + expand(desktop.build.nsis.artifactName));
  assert.equal(WINDOWS_PORTABLE_URL, release + expand(desktop.build.portable.artifactName));
});

test('the release workflow attaches both files', () => {
  const workflow = readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /tags: \['desktop-v\*'\]/);
  assert.match(workflow, /desktop\/dist\/HiddenMessenger-Setup-\*\.exe/);
  assert.match(workflow, /desktop\/dist\/HiddenMessenger-\*-portable\.exe/);
});
