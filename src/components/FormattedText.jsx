// Renders message formatting (src/textFormat.js). Three modes:
//   default  - bubbles: lines, quotes, lists, code blocks; links stay tappable (LinkText).
//   inline   - one-line previews (chat list, replies): styles kept, lines joined with spaces.
//   markers  - the composer's mirror layer: the markers stay visible (dimmed) and every style keeps the exact
//              width of the plain text, so the caret of the input on top lines up with what you see.
import { Fragment } from 'react';
import LinkText from './LinkText.jsx';
import { hasFormatting, parseBlocks, parseInline } from '../textFormat.js';

const TAG = { bold: 'strong', italic: 'em', strike: 'del' };

function Nodes({ nodes, links, markers }) {
  return nodes.map((node, index) => {
    if (node.type === 'text') return <Fragment key={index}>{links ? <LinkText text={node.text} /> : node.text}</Fragment>;
    if (markers) {
      const body = node.children ? <Nodes nodes={node.children} markers /> : node.text;
      return (
        <span key={index} className={`fmt-live fmt-live-${node.type}`}>
          <span className="fmt-marker">{node.marker}</span>{body}<span className="fmt-marker">{node.marker}</span>
        </span>
      );
    }
    if (node.type === 'mono' || node.type === 'code') return <code key={index} className={`fmt-${node.type}`}>{node.text}</code>;
    const Tag = TAG[node.type];
    return <Tag key={index} className={`fmt-${node.type}`}><Nodes nodes={node.children} links={links} /></Tag>;
  });
}

export default function FormattedText({ text = '', inline = false, markers = false, links = !inline && !markers }) {
  if (!text) return null;
  if (!hasFormatting(text)) return links ? <LinkText text={text} /> : text;
  if (markers) return <Nodes nodes={parseInline(text)} markers />;
  if (inline) return <Nodes nodes={parseInline(text.replace(/\s*\n\s*/g, ' '))} links={false} />;
  const lines = parseBlocks(text);
  return lines.map((line, index) => {
    const last = index === lines.length - 1;
    if (line.kind === 'code') return <code key={index} className="fmt-block">{line.text}</code>;
    const body = <Nodes nodes={line.nodes} links={links} />;
    if (line.kind === 'quote') return <span key={index} className="fmt-quote">{body}</span>;
    if (line.kind === 'bullet') return <span key={index} className="fmt-item"><span className="fmt-bullet" aria-hidden="true">•</span>{body}</span>;
    if (line.kind === 'number') return <span key={index} className="fmt-item"><span className="fmt-bullet">{line.number}.</span>{body}</span>;
    return <Fragment key={index}>{body}{!last && '\n'}</Fragment>;
  });
}
