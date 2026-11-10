import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELETE_FOR_EVERYONE_WINDOW_MS,
  canDeleteForEveryone,
  resolveSelection,
  selectionActions,
  toggleSelection,
} from '../src/selection.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const NOW = Date.parse('2024-05-01T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const msg = (id, extra = {}) => ({ id, senderId: 'me', content: `text ${id}`, timestamp: at(1000), status: 'sent', ...extra });

test('toggleSelection adds and removes ids', () => {
  assert.deepEqual(toggleSelection([], 'a'), ['a']);
  assert.deepEqual(toggleSelection(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleSelection(['b'], 'a'), ['b', 'a']);
});

test('resolveSelection returns live messages in chat order and drops deleted ones', () => {
  const messages = [msg('a'), msg('b', { starred: true }), msg('c')];
  assert.deepEqual(resolveSelection(messages, ['c', 'a', 'gone']).map((m) => m.id), ['a', 'c']);
  assert.equal(resolveSelection(messages, ['b'])[0].starred, true);
  assert.deepEqual(resolveSelection(messages, ['gone']), []);
  assert.deepEqual(resolveSelection(messages, []), []);
});

test('canDeleteForEveryone allows only my own server messages within the window', () => {
  assert.equal(canDeleteForEveryone(msg('a'), 'me', NOW), true);
  assert.equal(canDeleteForEveryone(msg('a'), 'you', NOW), false);
  assert.equal(canDeleteForEveryone(msg('a', { status: 'failed' }), 'me', NOW), false);
  assert.equal(canDeleteForEveryone(msg('a', { content: 'call:{}' }), 'me', NOW), false);
  assert.equal(canDeleteForEveryone(msg('a', { timestamp: at(DELETE_FOR_EVERYONE_WINDOW_MS + 1) }), 'me', NOW), false);
  assert.equal(canDeleteForEveryone(msg('a', { timestamp: 'not a date' }), 'me', NOW), false);
});

test('selectionActions matches WhatsApp single and bulk selection actions', () => {
  const single = selectionActions([msg('a')], 'me', NOW);
  assert.deepEqual(single, { count: 1, canReply: true, canInfo: true, canForward: true, canStar: true, allStarred: false, deleteForEveryone: true, hasMedia: false, canEdit: true, canPin: true });

  const bulk = selectionActions([msg('a', { starred: true }), msg('b', { starred: true, content: 'media:x:photo.png' })], 'me', NOW);
  assert.equal(bulk.count, 2);
  assert.equal(bulk.canReply, false);
  assert.equal(bulk.canInfo, false);
  assert.equal(bulk.allStarred, true);
  assert.equal(bulk.hasMedia, true);

  const mixed = selectionActions([msg('a'), msg('b', { senderId: 'you' }), msg('c', { content: 'call:{}' })], 'me', NOW);
  assert.equal(mixed.canForward, false, 'calls cannot be forwarded');
  assert.equal(mixed.deleteForEveryone, false, 'one ineligible message limits bulk delete to me');

  assert.equal(selectionActions([], 'me', NOW).canForward, false);

  // "You deleted this message": only Delete for me is left.
  const deleted = selectionActions([msg('d', { content: '', deleted: true })], 'me', NOW);
  assert.deepEqual(deleted, { count: 1, canReply: false, canInfo: false, canForward: false, canStar: false, allStarred: false, deleteForEveryone: false, hasMedia: false, canEdit: false, canPin: false });
});

test('chat window keeps selection and reactions isolated and resets cleanly', () => {
  const source = readFileSync(join(srcDir, 'components', 'ChatWindow.jsx'), 'utf8').replace(/\r\n/g, '\n');
  const css = readFileSync(join(srcDir, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  for (const needle of [
    // Selection is a set of ids resolved against live messages.
    'resolveSelection(messages, selectedIds)',
    // Taps are routed in the capture phase: selection mode toggles instead of opening media or quotes.
    'onClickCapture={handleClickCapture}',
    'if (!consumed) onToggleSelect(message);',
    // Tray presses are never message gestures, and a reaction ends the selection.
    "const TRAY_SELECTOR = '.wa-reaction-picker-bar'",
    'event.target.closest(TRAY_SELECTOR)',
    '{reactionTrayOpen && <ReactionTray onPick={onTrayReact} />}',
    'reactTo(message, emoji);\n                    clearSelection();',
    // The tray can only be open for a single selected message.
    'selectedMessages.length === 1 && selectedMessages[0].id === reactionTrayId',
    // Always-visible close, Escape, and chat change all return to the normal header.
    'onClick={clearSelection}',
    "if (event.key === 'Escape') clearSelection();",
    // Bulk forward and delete operate on every selected message.
    'setForwardSource(selectedMessages)',
    'setDeleteTarget(selectedMessages)',
    'for (const source of sources) sendToChat(target.id, source.content, { forwarded: true });',
    'setForwardSource([viewerMessage])',
    'setDeleteTarget([viewerMessage])',
    'Delete ${count} messages?',
  ]) {
    assert.ok(source.includes(needle), `ChatWindow.jsx is missing ${needle}`);
  }
  const header = source.slice(source.indexOf('wa-msg-selection-header'), source.indexOf('wa-sel-actions'));
  assert.ok(!header.includes('mobile-back'), 'the selection close button is not hidden on desktop');
  const resetEffect = source.slice(source.indexOf('setViewerMessageId(null);\n    setHighlightId(null);'), source.indexOf('}, [chatId, clearSelection]);'));
  assert.ok(resetEffect.includes('clearSelection();'), 'opening another chat clears the selection');
  for (const removed of ['setSelectedMessage', 'reactionPickerMessageId', 'onOpenReactionPicker', 'showExtendedPicker']) {
    assert.ok(!source.includes(removed), `superseded ${removed} is removed`);
  }

  const headerRule = css.slice(css.indexOf('.wa-msg-selection-header {'), css.indexOf('}', css.indexOf('.wa-msg-selection-header {')));
  assert.ok(!headerRule.includes('background'), 'the selection header keeps the normal header background');
  assert.ok(css.includes('.message-line.selecting'), 'selection mode disables text selection on messages');
});
