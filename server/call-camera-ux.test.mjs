// UX matched to what the S23 showed during WhatsApp / WhatsApp Business test calls and sends (2026-11-20, observed
// through Android's own diagnostics, no content): the front camera behind a ringing video call, a Video note tab in
// the camera, message notifications cleared when the app opens, and a 9:16 self view in video calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const java = (file) => read(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('a ringing video call shows the front camera, and lets go of it before answering', () => {
  const ring = java('IncomingCallActivity.java');
  const preview = java('RingPreview.java');
  assert.match(ring, /if \(video && RingPreview\.allowed\(this\)\) \{/, 'only for video calls, only with camera access already granted');
  assert.match(ring, /private void accept\(String callId\) \{\s*\/\/[^\n]*\n\s*if \(preview != null\) preview\.stop\(\);/, 'closed before the call opens the camera');
  assert.match(ring, /private void decline\(String callId\) \{\s*if \(preview != null\) preview\.stop\(\);/);
  assert.match(ring, /protected void onPause\(\) \{\s*if \(preview != null\) preview\.stop\(\);/, 'never left running behind another screen');
  assert.match(ring, /if \(cameraOff\) preview\.stop\(\); else preview\.start\(\);/, 'answering camera-off turns it off too');
  assert.match(preview, /checkSelfPermission\(Manifest\.permission\.CAMERA\) == PackageManager\.PERMISSION_GRANTED/, 'never asks for access itself');
  assert.match(preview, /CameraCharacteristics\.LENS_FACING_FRONT/);
  assert.ok(!/MediaRecorder|ImageReader/.test(preview), 'nothing is recorded or captured, only shown');
});

test('the camera offers Video note next to Video and Photo', () => {
  const camera = read('src/components/CameraCapture.jsx');
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(camera.includes("{onVideoNote && <button type=\"button\" role=\"tab\" aria-selected={false} disabled={recording} onClick={() => { stopStream(); onVideoNote(); }}>Video note</button>}"));
  assert.ok(chat.includes("onVideoNote={() => setPicker('videonote')}"), 'hands over to the existing video note recorder');
});

test('opening the app clears its message notifications (calls and missed calls stay)', () => {
  const app = read('src/App.jsx');
  assert.ok(app.includes("const clear = () => { if (document.visibilityState === 'visible') Promise.resolve(nativeClearMessageNotifications()).catch(() => {}); };"));
  const alerts = java('Alerts.java');
  assert.match(alerts, /static void cancelAllMessages\(Context context\) \{[\s\S]*?if \(posted\.getId\(\) == 1\) manager\.cancel\(posted\.getTag\(\), posted\.getId\(\)\);/, 'only message notifications (id 1)');
});

test('your own picture in a video call is 9:16', () => {
  const css = read('src/styles.css');
  const rule = css.match(/\n\.wa-video-tile\.is-pip \{\n  position: absolute;\n  right: (\d+)px;\n  bottom: 100px;\n  width: (\d+)px;\n  height: (\d+)px;/);
  assert.ok(rule, 'the self view rule');
  const [, , width, height] = rule.map(Number);
  assert.ok(Math.abs(width / height - 9 / 16) < 0.02, `9:16, got ${width}x${height}`);
});

// The minimised call window settles like Android's floating window (WhatsApp video call on the S23, 2026-11-21):
// against the nearer side or the side it was flung towards, at the height it was left; never into the bars.
test('the minimised call window snaps to a side and keeps its height; a fling picks the side', async () => {
  const { pipSnap, PIP_FLING_SPEED } = await import('../src/callWindow.js');
  const viewport = { width: 400, height: 800 };
  const box = (left, top) => ({ left, top, width: 120, height: 200 });
  assert.deepEqual(pipSnap(box(50, 300), 0, viewport), { x: 12, y: 300 }, 'left half: left side, same height');
  assert.deepEqual(pipSnap(box(230, 300), 0, viewport), { x: 268, y: 300 }, 'right half: right side');
  assert.deepEqual(pipSnap(box(230, 10), 0, viewport, 24), { x: 268, y: 88 }, 'not under the top bar');
  assert.deepEqual(pipSnap(box(50, 700), 0, viewport), { x: 12, y: 516 }, 'not over the bottom controls');
  assert.equal(pipSnap(box(50, 300), PIP_FLING_SPEED, viewport).x, 268, 'flung right from the left half: right side');
  assert.equal(pipSnap(box(230, 300), -PIP_FLING_SPEED, viewport).x, 12, 'flung left: left side');
  assert.equal(pipSnap(box(230, 300), PIP_FLING_SPEED / 2, viewport).x, 268, 'a slow drag keeps the nearer side');
});

// The status-bar icon read at about half the size of other apps' icons on the S23 (2026-11-21): it used the launcher
// icon's 108-unit canvas, so the mark covered only ~54% of the 24dp box. It is framed tightly now.
test('the status-bar icon fills its box like other status-bar icons, and every notification uses it', () => {
  const icon = read('android/app/src/main/res/drawable/ic_stat_hidden.xml');
  const size = Number(icon.match(/android:viewportWidth="(\d+)"/)[1]);
  assert.equal(size, Number(icon.match(/android:viewportHeight="(\d+)"/)[1]), 'square');
  const dx = Number(icon.match(/android:translateX="(-?\d+)"/)[1]);
  const dy = Number(icon.match(/android:translateY="(-?\d+)"/)[1]);
  // The mark: a bubble of radius 30 centred at (54,53) with its tail ending at (26,82.5).
  const [left, right, top, bottom] = [24 + dx, 84 + dx, 23 + dy, 83 + dy];
  assert.ok(left >= 0 && top >= 0 && right <= size && bottom <= size, 'nothing clipped');
  assert.ok((right - left) / size >= 0.8 && (bottom - top) / size >= 0.8, `fills at least 80% (${((right - left) / size).toFixed(2)})`);
  for (const file of ['Alerts.java', 'MessagingService.java', 'BackgroundHost.java', 'WakeKeeper.java', 'UploadService.java']) {
    const smallIcons = java(file).match(/setSmallIcon\([^)]*\)/g) ?? [];
    assert.ok(smallIcons.every((call) => call === 'setSmallIcon(R.drawable.ic_stat_hidden)'), `${file}: one icon everywhere`);
  }
});
