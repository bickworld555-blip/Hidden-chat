// Notification settings: model, sound planning, reminders/badge logic, the tone library and UI wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS,
  REMINDER_INTERVAL_MS,
  STORAGE_KEY,
  VIBRATE_OPTIONS,
  badgeCount,
  getNotificationSettings,
  normalizeSettings,
  resetNotificationSettingsCache,
  setSectionValue,
  shouldRemind,
  soundPlan,
  subscribeNotificationSettings,
  systemNotificationAllowed,
  updateNotificationSettings,
  vibrationPattern,
} from '../src/notificationSettings.js';
import {
  DEFAULT_NOTIFICATION_TONE,
  DEFAULT_RINGTONE,
  NOTIFICATION_TONES,
  RINGTONES,
  resolveToneChoice,
  toneChoiceLabel,
  toneDuration,
} from '../src/tones.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key), map };
}

test('settings normalise to the WhatsApp defaults and drop values the UI cannot represent', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const messy = normalizeSettings({
    conversationTones: 'yes',
    messages: { tone: 'crystal-bells', vibrate: 'bogus', light: 'blue', highPriority: false, reactions: 'nope' },
    calls: { ringtone: 'custom:abc', vibrate: 'long' },
    volume: { notification: 2, ringtone: 0.4 },
    extra: true,
  });
  assert.equal(messy.conversationTones, true, 'non-booleans fall back');
  assert.equal(messy.messages.tone, 'crystal-bells');
  assert.equal(messy.messages.vibrate, 'default', 'unknown vibration pattern falls back');
  assert.equal(messy.messages.light, 'blue');
  assert.equal(messy.messages.highPriority, false);
  assert.equal(messy.messages.reactions, true);
  assert.equal(messy.calls.ringtone, 'custom:abc');
  assert.equal(messy.calls.vibrate, 'long');
  assert.deepEqual(messy.volume, { notification: 0.8, ringtone: 0.4 });
  assert.equal('extra' in messy, false);
  assert.deepEqual(messy.groups, DEFAULT_SETTINGS.groups, 'missing sections are filled in');
});

test('the settings store persists to localStorage and notifies subscribers', () => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  resetNotificationSettingsCache();
  try {
    assert.deepEqual(getNotificationSettings(), DEFAULT_SETTINGS);
    const seen = [];
    const unsubscribe = subscribeNotificationSettings((next) => seen.push(next));
    setSectionValue('calls', 'ringtone', 'quantum-bell');
    updateNotificationSettings({ conversationTones: false });
    unsubscribe();
    assert.equal(seen.length, 2);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.equal(stored.calls.ringtone, 'quantum-bell');
    assert.equal(stored.conversationTones, false);
    resetNotificationSettingsCache();
    assert.equal(getNotificationSettings().calls.ringtone, 'quantum-bell', 'a fresh read comes back from storage');
    storage.setItem(STORAGE_KEY, '{not json');
    resetNotificationSettingsCache();
    assert.deepEqual(getNotificationSettings(), DEFAULT_SETTINGS, 'corrupt storage is ignored');
  } finally {
    delete globalThis.localStorage;
    resetNotificationSettingsCache();
  }
});

test('sound plans follow the switches: conversation tones silence messages, reactions have their own toggle, calls use the ringtone', () => {
  const settings = normalizeSettings({
    messages: { tone: 'orbit', vibrate: 'short' },
    calls: { ringtone: 'custom:ring1', vibrate: 'long' },
    volume: { notification: 0.5, ringtone: 0.9 },
  });
  assert.deepEqual(soundPlan('message', settings), { tone: 'orbit', vibrate: [80], volume: 0.5 });
  assert.deepEqual(soundPlan('reaction', settings), { tone: 'orbit', vibrate: [80], volume: 0.5 });
  assert.deepEqual(soundPlan('incomingCall', settings), { tone: 'custom:ring1', vibrate: [650], volume: 0.9 });
  assert.deepEqual(soundPlan('sent', settings), { tone: 'default', vibrate: [], volume: 0.5 });

  const noReactions = normalizeSettings({ ...settings, messages: { ...settings.messages, reactions: false } });
  assert.equal(soundPlan('reaction', noReactions).tone, 'silent');
  assert.equal(soundPlan('message', noReactions).tone, 'orbit', 'messages keep ringing');

  const quiet = normalizeSettings({ ...settings, conversationTones: false });
  assert.equal(soundPlan('message', quiet).tone, 'silent');
  assert.deepEqual(soundPlan('message', quiet).vibrate, []);
  assert.equal(soundPlan('sent', quiet).tone, 'silent');
  assert.equal(soundPlan('incomingCall', quiet).tone, 'custom:ring1', 'calls are not conversation tones');

  assert.deepEqual(vibrationPattern('off'), []);
  assert.deepEqual(vibrationPattern('unknown'), VIBRATE_OPTIONS[0].pattern);
  assert.equal(systemNotificationAllowed('message', settings), true);
  assert.equal(systemNotificationAllowed('reaction', noReactions), false);
  assert.equal(systemNotificationAllowed('message', normalizeSettings({ messages: { highPriority: false } })), false);
  assert.equal(systemNotificationAllowed('incomingCall', settings), false, 'calls have their own screen');
});

test('reminders fire at most once per interval while hidden, and the badge counts unread chats plus unviewed missed calls', () => {
  const base = { enabled: true, unseenCount: 2, hidden: true, lastRemindedAt: 0, now: REMINDER_INTERVAL_MS };
  assert.equal(shouldRemind(base), true);
  assert.equal(shouldRemind({ ...base, now: REMINDER_INTERVAL_MS - 1 }), false);
  assert.equal(shouldRemind({ ...base, hidden: false }), false);
  assert.equal(shouldRemind({ ...base, unseenCount: 0 }), false);
  assert.equal(shouldRemind({ ...base, enabled: false }), false);

  const chats = [{ id: 'a', unread: 3 }, { id: 'b', unread: 0 }, { id: 'c', unread: 1 }];
  const callLogs = [
    { status: 'missed', timestamp: '2026-11-06T10:00:00.000Z' },
    { status: 'missed', timestamp: '2026-11-06T12:00:00.000Z' },
    { status: 'completed', timestamp: '2026-11-06T13:00:00.000Z' },
  ];
  assert.equal(badgeCount({ enabled: true, chats, callLogs, callsSeenAt: 0 }), 4);
  assert.equal(badgeCount({ enabled: true, chats, callLogs, callsSeenAt: Date.parse('2026-11-06T11:00:00.000Z') }), 3, 'viewed missed calls drop out');
  assert.equal(badgeCount({ enabled: true, chats: [], callLogs: [], callsSeenAt: 0 }), 0, 'clears when everything is viewed');
  assert.equal(badgeCount({ enabled: false, chats, callLogs }), 0);
});

test('the tone library is original, consistent and resolves every kind of choice', () => {
  for (const [list, kind] of [[NOTIFICATION_TONES, 'notification'], [RINGTONES, 'ringtone']]) {
    const ids = list.map((tone) => tone.id);
    assert.equal(new Set(ids).size, ids.length, `${kind} ids are unique`);
    for (const tone of list) {
      assert.match(tone.id, /^[a-z0-9-]+$/);
      assert.ok(tone.name.length > 0 && tone.notes.length > 0);
      assert.ok(['sine', 'triangle', 'square', 'sawtooth'].includes(tone.wave));
      for (const [frequency, start, length, gain] of tone.notes) {
        assert.ok(frequency > 100 && frequency < 5000 && start >= 0 && length > 0 && (gain === undefined || (gain > 0 && gain <= 1)), `${tone.id} note is playable`);
      }
      const duration = toneDuration(tone);
      if (kind === 'ringtone') assert.ok(tone.period >= duration - 0.1 && duration >= 1, `${tone.id} loops cleanly`);
      else assert.ok(duration <= 1.2, `${tone.id} is a short notification`);
    }
    assert.doesNotMatch(JSON.stringify(list), /Samsung|Galaxy|BTS|SUGA|Over the Horizon/i, 'no third-party tone names or recordings');
  }
  assert.ok(NOTIFICATION_TONES.length >= 16 && RINGTONES.length >= 8);

  const custom = [{ id: 'c1', name: 'My ring', kind: 'ringtone', blob: {} }];
  assert.equal(resolveToneChoice('silent', 'notification').kind, 'silent');
  assert.equal(resolveToneChoice('default', 'notification').tone.id, DEFAULT_NOTIFICATION_TONE);
  assert.equal(toneChoiceLabel('default', 'notification'), 'Default (Pulse Beam)');
  assert.equal(toneChoiceLabel('default', 'ringtone'), `Default (${RINGTONES.find((tone) => tone.id === DEFAULT_RINGTONE).name})`);
  assert.equal(resolveToneChoice('custom:c1', 'ringtone', custom).kind, 'file');
  assert.equal(toneChoiceLabel('custom:c1', 'ringtone', custom), 'My ring');
  assert.equal(resolveToneChoice('custom:gone', 'ringtone', custom).tone.id, DEFAULT_RINGTONE, 'a deleted custom file falls back to the default rather than silence');
  assert.equal(resolveToneChoice('pulse-beam', 'ringtone').tone.id, DEFAULT_RINGTONE, 'a notification tone id is not a ringtone');
  assert.equal(resolveToneChoice('quantum-bell', 'ringtone').label, 'Quantum Bell');
});

test('the panel and the app are wired: sections, pickers, tones on events, vibration, badge and reminders', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const panel = await read('../src/components/NotificationSettings.jsx');
  const app = await read('../src/App.jsx');
  const overlay = await read('../src/components/CallOverlay.jsx');
  const chatWindow = await read('../src/components/ChatWindow.jsx');
  const tools = await read('../src/components/ToolsView.jsx');
  const sidebar = await read('../src/components/Sidebar.jsx');
  const sounds = await read('../src/sounds.js');

  for (const text of ['Conversation tones', 'Reminders', '<h3>Messages</h3>', '<h3>Groups</h3>', '<h3>Calls</h3>', '<h3>Status</h3>', 'App icon badge', 'Use high priority notifications', 'Reaction notifications', 'title="Ringtone"', 'title="Popup notification" subtitle="Not available"', 'Not available in a browser']) {
    assert.ok(panel.includes(text), `panel shows ${text}`);
  }
  assert.ok(panel.includes("option('silent', 'Silent')") && panel.includes('<h3>Custom</h3>') && panel.includes('Add from device'), 'the tone picker has Default / Silent / Custom / library');
  assert.ok(panel.includes('type="range"') && panel.includes('onVolume'), 'the picker has a volume slider');
  assert.ok(panel.includes("playToneChoice(choice, kind, { loop: kind === 'ringtone'"), 'choosing a tone previews it');
  assert.ok(panel.includes('requestNotificationPermission()'), 'high priority asks for system notification permission');
  assert.ok(!existsSync(new URL('../src/components/SoundSettings.jsx', import.meta.url)), 'the old sound panel is gone');

  assert.ok(app.includes("playNotificationTone('message')") && app.includes("vibrateFor('message')") && app.includes("showSystemNotification('message'"));
  assert.ok(app.includes("playNotificationTone('reaction')") && app.includes("showSystemNotification('reaction'"), 'reactions to my messages notify');
  assert.ok(app.includes('applyAppBadge({ chats, callLogs, callsSeenAt })') && app.includes('maybeRemind({ unseenCount: unseen() })'));
  assert.ok(app.includes('<NotificationSettings onClose=') && app.includes('onNotifications={() => setNotificationsOpen(true)}'));
  assert.ok(tools.includes('onClick={() => onNotifications?.()}') && sidebar.includes('title="Notifications" onClick={onNotifications}'));
  assert.ok(overlay.includes("vibrateFor('incomingCall')") && overlay.includes('stopVibration()'), 'incoming calls vibrate with the call pattern');
  assert.ok(chatWindow.includes("playNotificationTone('sent')"), 'outgoing messages play the conversation tone');
  assert.ok(sounds.includes("if (plan.tone === 'silent') return stopTone(categoryId)") && sounds.includes('playToneChoice(plan.tone, CATEGORY_KINDS[categoryId]'), 'playback follows the resolved choice');
});
