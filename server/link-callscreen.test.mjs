// Link preview cards (Facebook reels, YouTube…) and the WhatsApp-style ringing call screen: swipe up to accept,
// "Turn off your video", quick-reply "Message", and handing back to the lock screen when the call ends.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createLinkPreviews, isPrivateAddress, linkProvider, parseMetaTags } from './linkPreview.mjs';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const publicDns = async () => [{ address: '157.240.1.35' }];

test('link previews read Open Graph tags, follow redirects, and know the platform', async () => {
  const meta = parseMetaTags(`<head><title>Ignored</title><meta property="og:title" content="4.6K views &amp; 7.8K reactions | Reel by Tasmiya">
    <meta property="og:image" content="https://scontent.example/reel.jpg"><meta property="og:type" content="video.other"><meta property="video:duration" content="19"></head>`);
  assert.deepEqual([meta.title, meta.image, meta.type, meta.duration], ['4.6K views & 7.8K reactions | Reel by Tasmiya', 'https://scontent.example/reel.jpg', 'video.other', 19]);
  assert.equal(linkProvider('https://www.facebook.com/share/r/abc/'), 'facebook');
  assert.equal(linkProvider('https://youtu.be/xyz'), 'youtube');
  assert.equal(linkProvider('https://example.com/'), '');

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/share/v/')) return new Response(null, { status: 302, headers: { location: 'https://www.facebook.com/reel/123' } });
    return html('<meta property="og:title" content="A reel"><meta property="og:image" content="/thumb.jpg">');
  };
  const preview = createLinkPreviews({ fetchImpl, resolve: publicDns });
  const card = await preview('https://www.facebook.com/share/v/1F4yw9wB1N/');
  assert.deepEqual([card.title, card.image, card.provider, card.video], ['A reel', 'https://www.facebook.com/thumb.jpg', 'facebook', true]);
  await preview('https://www.facebook.com/share/v/1F4yw9wB1N/');
  assert.equal(calls.length, 2, 'cached: the second request fetches nothing');
});

test('link previews never fetch private, loopback or link-local addresses (including after a redirect)', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  let fetched = 0;
  const local = createLinkPreviews({ fetchImpl: async () => { fetched += 1; return html('<meta property="og:title" content="secret">'); }, resolve: async () => [{ address: '127.0.0.1' }] });
  assert.equal(await local('http://intranet.example/'), null);
  assert.equal(fetched, 0);
  const redirectToMetadata = createLinkPreviews({
    fetchImpl: async () => { fetched += 1; return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }); },
    resolve: publicDns,
  });
  assert.equal(await redirectToMetadata('https://short.example/x'), null);
  assert.equal(fetched, 1, 'the redirect target is refused before it is fetched');
  assert.equal(await local('http://example.com:8080/'), null, 'non-standard ports are not fetched');
});

test('chat bubbles show the preview card; a bare link shows the card alone once it loaded', async () => {
  const chat = await source('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('{href && <LinkPreview href={href} sessionToken={sessionToken} />}'));
  const css = await source('src/styles.css');
  assert.ok(css.includes('.app-shell .message-bubble .link-preview + p.link-preview-url { display: none; }'), 'without a preview the link text stays');
  const server = await source('server/index.mjs');
  assert.ok(server.includes("app.get('/api/v1/link-preview', requireSession,"), 'only signed-in users can ask the server to fetch a link');
});

test('ringing call screen: swipe up to accept, "Turn off your video", Message with quick replies', async () => {
  const screen = await java('IncomingCallActivity.java');
  assert.ok(screen.includes('action("Swipe up to accept"') && screen.includes('swipeUpToAccept(acceptColumn.getChildAt(0), () -> accept(callId));'));
  assert.ok(screen.includes('.putExtra(EXTRA_CAMERA_OFF, cameraOff)'), 'answer with the camera off');
  assert.ok(screen.includes('"I\'ll call you right back."') && screen.includes('.setAction(CallActionReceiver.ACTION_REPLY)'));
  const receiver = await java('CallActionReceiver.java');
  assert.match(receiver, /NativeRelay\.replyToPendingCall\(callId, text\) && NativeRelay\.declinePendingCall\(callId\)/, 'app closed: reply then decline through the service');
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.ok(overlay.includes("useChatStore.getState().sendMessage(latest.current.call.peerId, text.trim());"), 'app running: the web app sends the reply');
  assert.ok(overlay.includes('if (off) allEngines().forEach((engine) => engine.setCameraOff(true));'));
});

test('a call answered from the lock screen or another app hands back there when it ends', async () => {
  const activity = await java('MainActivity.java');
  assert.match(activity, /static void callRinging\(Context context\) \{[\s\S]*?ringingWhileAway = !visible \|\| \(keyguard != null && keyguard\.isKeyguardLocked\(\)\);/);
  assert.match(activity, /static void callEnded\(\) \{[\s\S]*?postDelayed\([\s\S]*?if \(!returnAfterCall \|\| MessagingService\.isCallActive\(\) \|\| Alerts\.isRinging\(\) \|\| activity == null\) return;[\s\S]*?activity\.moveTaskToBack\(true\);[\s\S]*?1500\);/);
  const service = await java('MessagingService.java');
  assert.ok(service.includes('if (!active && callActive) MainActivity.callEnded();'));
});
