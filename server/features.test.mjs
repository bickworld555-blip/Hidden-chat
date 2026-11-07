// Floating/PiP calls, screen sharing, download progress, camera shortcut, multi-account and the tone library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCallEngine } from '../src/callEngine.js';
import { downloadWithProgress, formatEta, formatRate, getDownload, progressStats, subscribeDownloads } from '../src/downloads.js';
import { MAX_ACCOUNTS, accountFromSession, nextActiveAfterRemoval, sessionFromAccount, upsertAccountList } from '../src/accounts.js';
import { NOTIFICATION_TONES, RINGTONES, TIMBRES } from '../src/tones.js';
import { COMPOSER_EMOJIS, COMPOSER_MAX_LENGTH, composerAction, insertAtCaret } from '../src/composer.js';
import { APPEARANCE_KEY, animationsAttribute, callAnimationsAttribute, getAppearance, normalizeAppearance, setAnimationsEnabled, setCallAnimationsEnabled } from '../src/appearance.js';

// --- Scripted WebRTC pieces (same shape as the real ones the engine touches) ------------------------

function fakeTrack(kind, label = kind) {
  return { kind, label, id: `${label}-${Math.random()}`, enabled: true, readyState: 'live', onended: null, getSettings: () => ({ deviceId: label }), stop() { this.readyState = 'ended'; } };
}

class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}

class FakeConnection {
  constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.senders = []; this.localDescription = null; this.remoteDescription = null; this.offers = 0; }
  addTrack(track, stream) { const sender = { track, stream, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, async replaceTrack(next) { this.track = next; } }; this.senders.push(sender); return sender; }
  getSenders() { return this.senders; }
  getTransceivers() { return []; }
  async createOffer() { this.offers += 1; return { type: 'offer', sdp: 'v=0\r\nfake' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake' }; }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = 'stable'; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}

async function connectedCall(mode, { getDisplayMedia } = {}) {
  const connections = [];
  const sent = [];
  const cameras = [];
  const engine = createCallEngine({
    callId: 'share', direction: 'outgoing', mode,
    rtc: { RTCPeerConnection: class extends FakeConnection { constructor() { super(); connections.push(this); } }, RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } }, MediaStream: FakeStream },
    getUserMedia: async (constraints) => { const tracks = [fakeTrack('audio')]; if (constraints.video) { const camera = fakeTrack('video', 'camera'); cameras.push(camera); tracks.push(camera); } return new FakeStream(tracks); },
    getDisplayMedia,
    send: (payload) => { sent.push(payload.signal); return true; },
  });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  connections[0].connect();
  return { engine, connection: connections[0], sent, cameras };
}

test('screen sharing replaces the camera for the peer, announces itself, and gives the camera back when it stops', async () => {
  const screens = [];
  const getDisplayMedia = async () => { const screen = fakeTrack('video', 'screen'); screens.push(screen); return new FakeStream([screen]); };
  const { engine, connection, sent, cameras } = await connectedCall('video', { getDisplayMedia });
  assert.equal(engine.canShareScreen, true);
  const sender = connection.getSenders().find((item) => item.track.kind === 'video');
  assert.equal(sender.track, cameras[0]);

  assert.equal(await engine.startScreenShare(), true);
  assert.equal(engine.state.screenSharing, true);
  assert.equal(sender.track, screens[0], 'the peer now receives the screen on the same sender (no renegotiation)');
  assert.equal(cameras[0].readyState, 'ended', 'the camera is released while sharing');
  assert.deepEqual(engine.state.localStream.getVideoTracks(), [screens[0]], 'the self view shows the screen');
  assert.deepEqual(sent.at(-1), { type: 'media', video: true, audio: true, screen: true, avatar: false });
  assert.equal(connection.offers, 1, 'replaceTrack needs no new offer');

  assert.equal(await engine.stopScreenShare(), true);
  assert.equal(engine.state.screenSharing, false);
  assert.equal(engine.state.mode, 'video');
  assert.equal(screens[0].readyState, 'ended');
  assert.equal(sender.track, cameras[1], 'a fresh camera track is sent again');
  assert.deepEqual(sent.at(-1), { type: 'media', video: true, audio: true, screen: false, avatar: false });

  // The browser's own "Stop sharing" button ends it the same way.
  await engine.startScreenShare();
  screens[1].onended();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(engine.state.screenSharing, false);
  assert.equal(sender.track, cameras[2]);
});

test('sharing a screen in a voice call adds video and returns to voice afterwards; no API means no button', async () => {
  const getDisplayMedia = async () => new FakeStream([fakeTrack('video', 'screen')]);
  const { engine, connection, sent } = await connectedCall('audio', { getDisplayMedia });
  assert.equal(await engine.startScreenShare(), true);
  assert.equal(engine.state.mode, 'video');
  assert.equal(connection.offers, 2, 'a new video sender needs renegotiation');
  await engine.stopScreenShare();
  assert.equal(engine.state.mode, 'audio', 'back to a voice call');
  assert.deepEqual(sent.at(-1), { type: 'media', video: false, audio: true, screen: false, avatar: false });
  assert.equal(connection.getSenders().find((item) => item.track === null || item.track?.kind === 'video')?.track ?? null, null, 'the video sender is left empty, not removed');

  const { engine: plain } = await connectedCall('audio');
  assert.equal(plain.canShareScreen, false);
  assert.equal(await plain.startScreenShare(), false);

  const denied = await connectedCall('audio', { getDisplayMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  assert.equal(await denied.engine.startScreenShare(), false);
  assert.equal(denied.engine.state.error, '', 'a cancelled picker is not an error');
  const peer = await connectedCall('video', { getDisplayMedia });
  peer.engine.deliver({ type: 'media', video: true, audio: true, screen: true, avatar: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peer.engine.state.remoteScreen, true, 'the receiving side knows it is looking at a screen');
});

// --- Download progress --------------------------------------------------------------------------------

test('progress maths: percentage, smoothed speed and time left', () => {
  const first = progressStats({ received: 1_000_000, total: 10_000_000, startedAt: 0, now: 1000 });
  assert.equal(first.fraction, 0.1);
  assert.equal(first.rate, 1_000_000);
  assert.equal(first.etaSeconds, 9);
  const second = progressStats({ received: 4_000_000, total: 10_000_000, startedAt: 0, now: 2000, previousRate: first.rate });
  assert.ok(second.rate > 1_000_000 && second.rate < 2_000_000, 'speed is smoothed, not instantaneous');
  assert.equal(progressStats({ received: 5, total: 0, startedAt: 0, now: 1 }).etaSeconds, null);
  assert.equal(formatEta(0.4), 'almost done');
  assert.equal(formatEta(42), '42 s left');
  assert.equal(formatEta(125), '3 min left');
  assert.equal(formatEta(3700), '1 h 2 min left');
  assert.equal(formatRate(512 * 1024), '512 KB/s');
  assert.equal(formatRate(3.2 * 1024 * 1024), '3.2 MB/s');
});

test('downloads stream to a picked file with live progress and can be cancelled', async () => {
  const written = [];
  const chunks = [new Uint8Array(400_000), new Uint8Array(400_000), new Uint8Array(200_000)];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.window = { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async (chunk) => { written.push(chunk.byteLength); }, close: async () => { written.push('closed'); }, abort: async () => { written.push('aborted'); } }) }) };
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '1000000', 'content-type': 'video/mp4' } });
    let index = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (index === 1) await gate;
        if (init?.signal?.aborted) { controller.error(new DOMException('Aborted', 'AbortError')); return; }
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  try {
    const seen = [];
    const unsubscribe = subscribeDownloads(() => { const progress = getDownload('m1'); if (progress) seen.push({ status: progress.status, fraction: progress.fraction }); });
    const done = downloadWithProgress('m1', 'clip.mp4', 'token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getDownload('m1').status, 'running');
    assert.equal(getDownload('m1').total, 1_000_000);
    assert.equal(getDownload('m1').received, 400_000, 'the first chunk is on disk and counted');
    assert.ok(getDownload('m1').etaSeconds >= 0);
    release();
    await done;
    unsubscribe();
    assert.equal(seen.at(-1).status, 'done');
    assert.deepEqual(written, [400_000, 400_000, 200_000, 'closed']);
    assert.ok(seen.some((item) => item.fraction > 0 && item.fraction < 1), 'intermediate progress was published');

    // Cancelling mid-stream aborts the write and reports it.
    let release2;
    const gate2 = new Promise((resolve) => { release2 = resolve; });
    written.length = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '1000000' } });
      let index = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (index === 1) { await gate2; controller.error(new DOMException('Aborted', 'AbortError')); return; }
          controller.enqueue(chunks[index++]);
        },
      }), { status: 200 });
    };
    const cancelled = downloadWithProgress('m2', 'clip.mp4', 'token');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { cancelDownload } = await import('../src/downloads.js');
    cancelDownload('m2');
    release2();
    await cancelled;
    assert.equal(getDownload('m2').status, 'cancelled');
    assert.ok(written.includes('aborted'));
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.window;
  }
});

// --- Accounts -----------------------------------------------------------------------------------------

test('account list helpers: upsert keeps the newest first and capped, removal picks the next most recent', () => {
  const session = { token: 't1', user: { id: 'u1', username: 'one', name: 'One' }, deviceId: 'd1', deviceName: 'Phone' };
  const account = accountFromSession(session);
  assert.equal(account.id, 'u1');
  assert.deepEqual(sessionFromAccount(account), { token: 't1', deviceId: 'd1', deviceName: 'Phone', user: session.user });
  assert.equal(accountFromSession({ token: '', user: { id: 'x' } }), null);

  let list = [];
  for (let index = 1; index <= MAX_ACCOUNTS + 2; index += 1) {
    list = upsertAccountList(list, { id: `u${index}`, token: `t${index}`, user: { id: `u${index}` }, lastActiveAt: index });
  }
  assert.equal(list.length, MAX_ACCOUNTS, 'capped');
  assert.equal(list[0].id, `u${MAX_ACCOUNTS + 2}`, 'newest first');
  const refreshed = upsertAccountList(list, { ...list[2], token: 'renewed' });
  assert.equal(refreshed[0].token, 'renewed');
  assert.equal(refreshed.filter((item) => item.id === list[2].id).length, 1, 'no duplicates');

  const accounts = [{ id: 'a', lastActiveAt: 1 }, { id: 'b', lastActiveAt: 5 }, { id: 'c', lastActiveAt: 3 }];
  assert.equal(nextActiveAfterRemoval(accounts, 'b', 'b'), 'c', 'the most recently used remaining account takes over');
  assert.equal(nextActiveAfterRemoval(accounts, 'a', 'b'), 'b', 'removing another account keeps the active one');
  assert.equal(nextActiveAfterRemoval([{ id: 'only' }], 'only', 'only'), null);
});

// --- Tone library -------------------------------------------------------------------------------------

test('the library grew with richer timbres and stays consistent', () => {
  assert.ok(NOTIFICATION_TONES.length >= 30, `notification tones: ${NOTIFICATION_TONES.length}`);
  assert.ok(RINGTONES.length >= 16, `ringtones: ${RINGTONES.length}`);
  for (const tone of [...NOTIFICATION_TONES, ...RINGTONES]) {
    assert.ok(tone.timbre === undefined || tone.timbre in TIMBRES, `${tone.id} timbre`);
  }
  assert.ok([...NOTIFICATION_TONES, ...RINGTONES].filter((tone) => tone.timbre === 'bell').length >= 8, 'plenty of bell-like tones');
  for (const partials of Object.values(TIMBRES)) {
    for (const partial of partials) assert.ok(partial.ratio > 0 && partial.gain > 0 && partial.gain <= 1 && partial.decay > 0);
  }
});

// --- UI wiring ----------------------------------------------------------------------------------------

test('the UI wires PiP calls, screen sharing, download progress, the camera shortcut and account switching', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const overlay = await read('../src/components/CallOverlay.jsx');
  const list = await read('../src/components/ChatsList.jsx');
  const renderer = await read('../src/components/MediaRenderer.jsx');
  const viewer = await read('../src/components/MediaViewer.jsx');
  const voice = await read('../src/components/VoiceMessage.jsx');
  const app = await read('../src/App.jsx');
  const switcher = await read('../src/components/AccountSwitcher.jsx');
  const tools = await read('../src/components/ToolsView.jsx');
  const sidebar = await read('../src/components/Sidebar.jsx');
  const styles = await read('../src/styles.css');

  assert.ok(overlay.includes("minimized ? 'is-pip' : ''") && overlay.includes('className="wa-pip-bar"') && overlay.includes('onPointerMove={onPipPointerMove}'), 'a draggable floating window replaces the pill');
  assert.ok(overlay.includes('requestPictureInPicture()') && overlay.includes('document.pictureInPictureEnabled'), 'native picture-in-picture when the browser offers it');
  assert.ok(overlay.includes('toggleScreenShare') && overlay.includes("Share screen") && overlay.includes('getDisplayMedia: navigator.mediaDevices?.getDisplayMedia'), 'screen sharing from the call controls');
  assert.ok(overlay.includes('is sharing their screen') && overlay.includes("remoteScreen ? 'is-screen'"), 'the remote tile shows screens unscaled with a badge');
  assert.ok(styles.includes('.wa-call-backdrop.is-pip') && styles.includes('.wa-video-element.is-screen { object-fit: contain'));

  assert.ok(list.includes('aria-label="Camera"') && list.includes('capture="environment"') && list.includes('sendCapturedPhoto(contact, capturedPhoto)'), 'home camera shortcut captures then picks a chat');
  assert.ok(renderer.includes('<DownloadProgress id={id} />') && renderer.includes('downloadWithProgress(id, filename, sessionToken)'), 'attachments show live download progress');
  assert.ok(viewer.includes('<DownloadProgress id={ref.id} />'));
  assert.ok(voice.includes('onProgress: (fraction) => setLoading(Math.round(fraction * 100))') && voice.includes('{loading}%'), 'voice notes show a loading percentage');

  assert.ok(app.includes('async function switchAccount(id)') && app.includes('addOrActivateAccount(session)') && app.includes('removeAccountFromDevice'), 'accounts are added, switched and removed');
  assert.ok(app.includes('const following = next.accounts.find((item) => item.id === next.activeId)'), 'logging out the active account moves to the next one');
  assert.ok(switcher.includes("aria-current={active ? 'true' : undefined}") && switcher.includes('Add account'), 'the switcher marks the active account');
  assert.ok(tools.includes('<strong>Accounts</strong>') && tools.includes('account-strip') && sidebar.includes('Switch account'), 'entry points in Tools and the sidebar');
});

test('composer helpers: caret-aware emoji insertion and the voice/send action', () => {
  assert.equal(composerAction(''), 'voice');
  assert.equal(composerAction('   '), 'voice');
  assert.equal(composerAction('hi'), 'send');
  assert.deepEqual(insertAtCaret('hello world', '👍', 5, 5), { text: 'hello👍 world', caret: 7, inserted: true });
  assert.deepEqual(insertAtCaret('hello world', '❤️', 0, 5), { text: '❤️ world', caret: 2, inserted: true }, 'a selection is replaced');
  assert.deepEqual(insertAtCaret('abc', '🙏', null, null), { text: 'abc🙏', caret: 5, inserted: true }, 'no caret appends');
  assert.equal(insertAtCaret('abc', '🙏', 99, 99).text, 'abc🙏', 'out-of-range carets clamp');
  assert.equal(insertAtCaret('x'.repeat(COMPOSER_MAX_LENGTH), '😀', 10).inserted, false, 'the 4,000 character limit holds');
  assert.ok(COMPOSER_EMOJIS.length >= 100 && new Set(COMPOSER_EMOJIS).size === COMPOSER_EMOJIS.length, 'a rich tray without duplicates');
});

test('the Animation setting is normalised, persisted and exposed as a data attribute', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    assert.deepEqual(normalizeAppearance(null), { animations: true, callAnimations: true, avatarCalls: false });
    assert.deepEqual(normalizeAppearance({ animations: 'nope' }), { animations: true, callAnimations: true, avatarCalls: false });
    assert.deepEqual(normalizeAppearance({ animations: false }), { animations: false, callAnimations: true, avatarCalls: false });
    assert.equal(animationsAttribute(getAppearance()), 'on');
    assert.equal(callAnimationsAttribute(getAppearance()), 'on');
    assert.deepEqual(setAnimationsEnabled(false), { animations: false, callAnimations: true, avatarCalls: false });
    assert.equal(animationsAttribute(), 'off');
    assert.equal(callAnimationsAttribute(), 'off', 'the master switch also stills the call screens');
    assert.equal(JSON.parse(store.get(APPEARANCE_KEY)).animations, false, 'the choice is stored per device');
    setAnimationsEnabled(true);
    assert.equal(animationsAttribute(), 'on');
    assert.deepEqual(setCallAnimationsEnabled(false), { animations: true, callAnimations: false, avatarCalls: false });
    assert.deepEqual([animationsAttribute(), callAnimationsAttribute()], ['on', 'off'], 'call motion can be off on its own');
    assert.equal(JSON.parse(store.get(APPEARANCE_KEY)).callAnimations, false);
    setCallAnimationsEnabled(true);
    assert.equal(normalizeAppearance({ avatarCalls: true }).avatarCalls, true, 'Animation Video Call (avatar) is opt-in');
  } finally {
    delete globalThis.localStorage;
  }
});

test('the UI wires the WhatsApp composer, display names, the live-location sheet and the Animation toggle', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const chat = await read('../src/components/ChatWindow.jsx');
  const tools = await read('../src/components/ToolsView.jsx');
  const sidebar = await read('../src/components/Sidebar.jsx');
  const drawer = await read('../src/components/ContactInfoDrawer.jsx');
  const app = await read('../src/App.jsx');
  const styles = await read('../src/styles.css');

  const pill = chat.slice(chat.indexOf('<div className="composer-row">'), chat.indexOf('<div className="composer-row">') + 1800);
  for (const needle of ['aria-label="Emoji"', 'ref={composerInputRef}', 'aria-label="Attach"', 'aria-label="Camera"', 'className="composer-fab"', 'aria-label="Send"', 'aria-label="Record voice note"']) {
    assert.ok(pill.includes(needle), `composer has ${needle}`);
  }
  assert.ok(pill.indexOf('aria-label="Emoji"') < pill.indexOf('ref={composerInputRef}') && pill.indexOf('ref={composerInputRef}') < pill.indexOf('aria-label="Attach"') && pill.indexOf('aria-label="Attach"') < pill.indexOf('aria-label="Camera"'), 'emoji · input · clip · camera in WhatsApp order');
  assert.ok(chat.includes("action === 'voice' && (") && chat.includes("action === 'send' ? (") && chat.includes('insertEmoji(emoji)'), 'the FAB flips between mic and send; emoji insert at the caret');
  assert.ok(styles.includes('.composer-fab {') && styles.includes('.composer-emoji-tray {') && styles.includes('border-radius: 24px'), 'pill and FAB styling');

  assert.ok(tools.includes('function DisplayNameEditor') && tools.includes('updateDisplayName(draft, sessionToken)') && tools.includes('className="user-handle"') && tools.includes('ID · {userId}'), 'the profile card edits the display name and shows the @handle and ID separately');
  assert.ok(tools.includes('className="display-name-pencil"') && tools.includes('aria-label="Edit display name"') && styles.includes('.display-name-pencil {') && !styles.includes('.display-name-button svg { color: #89969b; opacity: 0;'), 'an always-visible pencil beside the name opens the editor');
  assert.ok(sidebar.includes('presentName(user)') && drawer.includes('presentName(chat)') && chat.includes('presentName(chat)') && chat.includes('className="conversation-handle"'), 'headers distinguish display name from handle');

  assert.ok(tools.includes('<strong>Animation</strong>') && tools.includes('setAnimationsEnabled(!animations)') && tools.includes('role="switch"'), 'an Animation switch in Settings & Preferences');
  assert.ok(tools.includes('<strong>Animation Video Call</strong>') && tools.includes('setCallAnimationsEnabled(!callAnimations)') && tools.includes('Off while Animation is off'), 'a separate Animation Video Call switch with its own description');
  assert.ok(app.includes('document.documentElement.dataset.animations = animationsAttribute(appearance)') && app.includes('data-animations={animationsAttribute(appearance)}'), 'the preference is applied to the document');
  assert.ok(app.includes('data-call-animations={callAnimationsAttribute(appearance)}') && styles.includes('[data-call-animations="off"] .wa-call-backdrop *'), 'call-screen motion is scoped to the call overlay');
  assert.ok(styles.includes('[data-animations="off"] *') && styles.includes('transition-duration: 0s !important'), 'one rule turns motion off');
});
