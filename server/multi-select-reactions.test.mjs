import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');

test('Multi-select chat actions and pinning/muting logic in store', async () => {
  const storePath = join(srcDir, 'store.js');
  assert.ok(existsSync(storePath), 'store.js exists');
  const storeContent = readFileSync(storePath, 'utf8');

  assert.ok(storeContent.includes('pinnedChatIds'), 'store has pinnedChatIds state');
  assert.ok(storeContent.includes('mutedChatIds'), 'store has mutedChatIds state');
  assert.ok(storeContent.includes('togglePinChat'), 'store has togglePinChat action');
  assert.ok(storeContent.includes('toggleMuteChat'), 'store has toggleMuteChat action');
  assert.ok(storeContent.includes('deleteChat'), 'store has deleteChat action');
  assert.ok(storeContent.includes('toggleReaction'), 'store has toggleReaction action');
  assert.ok(storeContent.includes('deleteMessage'), 'store has deleteMessage action');
});

test('ChatsList component supports multi-select top action bar and pin/mute badges', async () => {
  const chatsListPath = join(srcDir, 'components', 'ChatsList.jsx');
  assert.ok(existsSync(chatsListPath), 'ChatsList.jsx exists');
  const content = readFileSync(chatsListPath, 'utf8');

  assert.ok(content.includes('wa-selection-header'), 'ChatsList renders wa-selection-header when selected');
  assert.ok(content.includes('selectedChatIds'), 'ChatsList tracks selectedChatIds');
  assert.ok(content.includes('handleBatchPin'), 'ChatsList handles batch pinning');
  assert.ok(content.includes('handleBatchMute'), 'ChatsList handles batch muting');
  assert.ok(content.includes('handleBatchDelete'), 'ChatsList handles batch deletion');
  assert.ok(content.includes('wa-row-check-badge'), 'ChatsList shows checkmark badge on selected rows');
});

test('ChatWindow component supports emoji reactions and contextual message actions', async () => {
  const chatWindowPath = join(srcDir, 'components', 'ChatWindow.jsx');
  assert.ok(existsSync(chatWindowPath), 'ChatWindow.jsx exists');
  const content = readFileSync(chatWindowPath, 'utf8');

  assert.ok(content.includes('wa-reaction-picker-bar'), 'ChatWindow has floating emoji reaction picker');
  assert.ok(content.includes('wa-bubble-reactions'), 'ChatWindow renders reaction badges on bubbles');
  assert.ok(content.includes('wa-msg-selection-header'), 'ChatWindow renders top contextual header when message selected');
  assert.ok(content.includes('startReply(selectedMessages[0])'), 'ChatWindow implements Reply action');
  assert.ok(content.includes('handleForwardMessage'), 'ChatWindow implements Forward message action');
  assert.ok(content.includes('setDeleteTarget(selectedMessages)'), 'ChatWindow implements Delete message action');
  assert.ok(content.includes('ForwardPickerModal'), 'ChatWindow includes Forward modal picker');
});

test('ChatWindow auto-scrolls to the latest message and offers a jump-to-latest control', async () => {
  const content = readFileSync(join(srcDir, 'components', 'ChatWindow.jsx'), 'utf8');
  const css = readFileSync(join(srcDir, 'styles.css'), 'utf8');

  assert.ok(content.includes('ref={messagesEndRef}'), 'ChatWindow renders a bottom anchor for the message feed');
  assert.ok(content.includes('ref={messageScrollRef}'), 'ChatWindow owns the scroll container it scrolls');
  assert.ok(content.includes('container.scrollTop = container.scrollHeight'), 'ChatWindow pins the container itself to the bottom');
  assert.ok(content.includes("scrollIntoView?.({ block: 'end', behavior: 'auto' })"), 'the anchor is the fallback when the container is missing');
  assert.ok(content.includes("scrollToBottom('auto')") && content.includes('useLayoutEffect'), 'opening a chat anchors instantly on the latest message');
  assert.ok(content.includes('requestAnimationFrame'), 'opening a chat re-pins on the next frame to absorb late layout');
  assert.ok(content.includes("scrollToBottom(firstLoad ? 'auto' : 'smooth')"), 'new messages scroll smoothly to the bottom');
  assert.ok(content.includes('new ResizeObserver'), 'ChatWindow re-anchors when the feed or container changes height');
  assert.ok(content.includes('stickToBottomRef'), 'ChatWindow tracks whether the reader is pinned to the bottom');
  assert.ok(content.includes('onScroll={syncScrollState}'), 'ChatWindow re-evaluates pinning as the user scrolls through history');
  assert.ok(content.includes('onWheel={cancelAutoScroll}'), 'user scroll gestures cancel an in-flight auto-scroll');
  assert.ok(content.includes('className="scroll-bottom"') && content.includes('scroll-bottom-badge'), 'ChatWindow renders a jump-to-latest button with an unseen badge');
  assert.ok(css.includes('.scroll-bottom-badge'), 'styles define the jump-to-latest badge');
});

test('CSS styles contain multi-select and reaction classes matching WhatsApp UI', async () => {
  const stylesPath = join(srcDir, 'styles.css');
  assert.ok(existsSync(stylesPath), 'styles.css exists');
  const content = readFileSync(stylesPath, 'utf8');

  assert.ok(content.includes('.wa-selection-header'), 'CSS has .wa-selection-header');
  assert.ok(content.includes('.wa-reaction-picker-bar'), 'CSS has .wa-reaction-picker-bar');
  assert.ok(content.includes('.wa-bubble-reactions'), 'CSS has .wa-bubble-reactions');
  assert.ok(content.includes('.wa-msg-selection-header'), 'CSS has .wa-msg-selection-header');
  assert.ok(content.includes('.wa-quoted-reply-preview'), 'CSS has .wa-quoted-reply-preview');
  assert.ok(content.includes('.wa-composer-reply-banner'), 'CSS has .wa-composer-reply-banner');
});
