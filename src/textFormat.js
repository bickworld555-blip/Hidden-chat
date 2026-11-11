// Message formatting, with the same markers as other messengers: *bold*, _italic_, ~strike~, ```monospace```
// and `inline code`, plus line-level "> quote", "- item" / "* item" bullets and "1. item" numbered lists.
//
// A marker pair formats only when the opening marker starts a word (start of text, whitespace or punctuation
// before it, a non-space after it) and the closing marker ends one (a non-space before it, end of text,
// whitespace or punctuation after it), and both are on the same line. So "2*3*4", "snake_case_name" and a lone
// "*" stay as typed. Code (``` or `) is literal: nothing inside it is formatted. Styles nest (*_both_*).
//
// parseInline(text) -> nodes: { type: 'text', text } | { type: 'bold'|'italic'|'strike', children, marker }
//                              | { type: 'mono'|'code', text, marker }
// parseBlocks(text) -> lines: { kind: 'text'|'quote'|'bullet'|'number', number?, nodes }
// plainText(text)   -> the text without markers (notifications, search, accessibility labels).

const PAIRS = { '*': 'bold', _: 'italic', '~': 'strike' };
const BOUNDARY = /[\s.,;:!?'"()[\]{}<>/\\|-]/;
const isBoundary = (char) => char === undefined || BOUNDARY.test(char);
const isSpace = (char) => char === undefined || /\s/.test(char);

function findClose(text, marker, from) {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === '\n') return -1;
    if (text.startsWith(marker, index) && !isSpace(text[index - 1]) && isBoundary(text[index + marker.length])) return index;
  }
  return -1;
}

export function parseInline(text = '') {
  const nodes = [];
  let plain = '';
  const flush = () => { if (plain) { nodes.push({ type: 'text', text: plain }); plain = ''; } };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const opens = isBoundary(text[index - 1]);
    if (opens && text.startsWith('```', index) && !isSpace(text[index + 3])) {
      const close = text.indexOf('```', index + 3);
      if (close > index + 3 && !isSpace(text[close - 1])) {
        flush();
        nodes.push({ type: 'mono', text: text.slice(index + 3, close), marker: '```' });
        index = close + 3;
        continue;
      }
    }
    if (opens && char === '`' && text[index + 1] !== '`' && !isSpace(text[index + 1])) {
      const close = findClose(text, '`', index + 1);
      if (close > index + 1) {
        flush();
        nodes.push({ type: 'code', text: text.slice(index + 1, close), marker: '`' });
        index = close + 1;
        continue;
      }
    }
    if (opens && PAIRS[char] && !isSpace(text[index + 1]) && text[index + 1] !== char) {
      const close = findClose(text, char, index + 1);
      if (close > index + 1) {
        flush();
        nodes.push({ type: PAIRS[char], children: parseInline(text.slice(index + 1, close)), marker: char });
        index = close + 1;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  flush();
  return nodes;
}

/** Splits into lines with their list / quote kind. A ``` block that spans lines stays one monospace line. */
export function parseBlocks(text = '') {
  const lines = [];
  const source = String(text);
  // Multi-line code blocks first, so their lines are not read as lists or quotes.
  // Only blocks that span lines are split out; a one-line ```code``` stays inline (parseInline).
  const parts = source.split(/(```[^`]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('```') && part.endsWith('```') && part.includes('\n') && part.length > 6) {
      lines.push({ kind: 'code', text: part.slice(3, -3).replace(/^\n|\n$/g, '') });
      continue;
    }
    // Text around a block starts or ends with the newline that separated them.
    const trimmed = lines.length && lines.at(-1).kind === 'code' ? part.replace(/^\n/, '') : part;
    const split = (parts.indexOf(part) < parts.length - 1 ? trimmed.replace(/\n$/, '') : trimmed).split('\n');
    for (const line of split) {
      let match;
      if ((match = /^> (.*)$/.exec(line))) lines.push({ kind: 'quote', nodes: parseInline(match[1]) });
      else if ((match = /^[-*] (.+)$/.exec(line))) lines.push({ kind: 'bullet', nodes: parseInline(match[1]) });
      else if ((match = /^(\d{1,3})\. (.+)$/.exec(line))) lines.push({ kind: 'number', number: Number(match[1]), nodes: parseInline(match[2]) });
      else lines.push({ kind: 'text', nodes: parseInline(line) });
    }
  }
  return lines;
}

const flatten = (nodes) => nodes.map((node) => (node.children ? flatten(node.children) : node.text)).join('');

/** The text as people read it, without formatting markers. */
export function plainText(text = '') {
  return parseBlocks(text).map((line) => {
    if (line.kind === 'code') return line.text;
    const body = flatten(line.nodes);
    if (line.kind === 'quote') return body;
    if (line.kind === 'bullet') return `• ${body}`;
    if (line.kind === 'number') return `${line.number}. ${body}`;
    return body;
  }).join('\n');
}

/** Whether the text has any formatting (so plain messages skip the formatter entirely). */
export const hasFormatting = (text = '') => /[*_~`]|^(> |[-*] |\d{1,3}\. )/m.test(text);
