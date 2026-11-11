// Message formatting rules (src/textFormat.js): markers only at word boundaries, code literal, styles nest,
// line-level quotes and lists, and the plain text used for notifications.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { hasFormatting, parseBlocks, parseInline, plainText } from '../src/textFormat.js';

const shape = (nodes) => nodes.map((node) => (node.type === 'text' ? node.text : node.children ? { [node.type]: shape(node.children) } : { [node.type]: node.text }));

test('bold, italic, strike, monospace and inline code format at word boundaries', () => {
  assert.deepEqual(shape(parseInline('*bold* _it_ ~gone~ ```mono``` `code`')), [{ bold: ['bold'] }, ' ', { italic: ['it'] }, ' ', { strike: ['gone'] }, ' ', { mono: 'mono' }, ' ', { code: 'code' }]);
  assert.deepEqual(shape(parseInline('(*hi*), ok!')), ['(', { bold: ['hi'] }, '), ok!']);
  assert.deepEqual(shape(parseInline('*_both_*')), [{ bold: [{ italic: ['both'] }] }]);
});

test('markers inside words, with spaces inside, unclosed or across lines stay as typed', () => {
  for (const text of ['2*3*4', 'snake_case_name', 'a * b * c', '* spaced *', '*open', 'line *one\ntwo*', '**', 'x_y_']) {
    assert.deepEqual(shape(parseInline(text)), text.split('\n').length > 1 ? [text] : [text], text);
  }
});

test('code is literal: nothing inside it is formatted', () => {
  assert.deepEqual(shape(parseInline('```*not bold*```')), [{ mono: '*not bold*' }]);
  assert.deepEqual(shape(parseInline('`_x_`')), [{ code: '_x_' }]);
});

test('quotes, bullets, numbered lists and multi-line code blocks', () => {
  const lines = parseBlocks('> quoted\n- one\n* two\n12. twelve\nplain\n```\nconst a = 1;\n*b*\n```\nafter');
  assert.deepEqual(lines.map((line) => line.kind), ['quote', 'bullet', 'bullet', 'number', 'text', 'code', 'text']);
  assert.equal(lines[3].number, 12);
  assert.equal(lines[5].text, 'const a = 1;\n*b*');
  assert.deepEqual(shape(lines[6].nodes), ['after']);
});

test('plain text drops markers for notifications; plain messages skip the formatter', () => {
  assert.equal(plainText('*Sale* _today_ ~only~ `now`\n- item\n1. first'), 'Sale today only now\n• item\n1. first');
  assert.equal(plainText('2*3*4'), '2*3*4');
  assert.equal(hasFormatting('hello there'), false);
  assert.equal(hasFormatting('*hi*'), true);
});

test('bubbles, previews, mentions, notifications and the composer use the formatter', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const [chat, list, assist, notify] = await Promise.all([read('../src/components/ChatWindow.jsx'), read('../src/components/ChatsList.jsx'), read('../src/components/parity/ComposerAssist.jsx'), read('../src/notify.js')]);
  assert.ok(chat.includes('<FormattedText text={content} />') && chat.includes('<ComposerMirror inputRef={composerInputRef} text={text} />'));
  assert.ok(list.includes('<FormattedText text={row.preview} inline />') && list.includes("<FormattedText text={chat.preview || 'No messages yet'} inline />"));
  assert.ok(assist.includes('<FormattedText text={text} />'));
  assert.ok(notify.includes('plainText(rawBody)'));
});
