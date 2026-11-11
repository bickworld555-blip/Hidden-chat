// Live formatting in the message box. The input stays a normal <input> (typing, IME, caret, selection,
// autofill all native); when the text has formatting markers, its own glyphs turn transparent and this layer
// behind it draws the same text with the markers dimmed and the styles applied. Every style keeps the plain
// text's width (bold is a stroke, italic a skew, code a tint), and the layer copies the input's font, padding
// and scroll position, so the caret stays on the right character. Works for the one-line <input> and the
// growing <textarea> (then it wraps the same way and follows the vertical scroll).
import { useLayoutEffect, useRef } from 'react';
import FormattedText from './FormattedText.jsx';

const COPIED = ['font', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderLeftWidth', 'borderRightWidth', 'textIndent'];

export default function ComposerMirror({ inputRef, text }) {
  const mirrorRef = useRef(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return undefined;
    const style = getComputedStyle(input);
    for (const property of COPIED) mirror.style[property] = style[property];
    mirror.classList.toggle('is-multiline', input.tagName === 'TEXTAREA');
    // Follow the field's box: the text area grows as lines are added (after this effect has run).
    const place = () => {
      mirror.style.left = `${input.offsetLeft}px`;
      mirror.style.top = `${input.offsetTop}px`;
      mirror.style.width = `${input.offsetWidth}px`;
      mirror.style.height = `${input.offsetHeight}px`;
      mirror.scrollLeft = input.scrollLeft;
      mirror.scrollTop = input.scrollTop;
    };
    place();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    resize?.observe(input);
    input.addEventListener('scroll', place);
    input.addEventListener('keyup', place);
    input.addEventListener('select', place);
    const frame = requestAnimationFrame(place);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      input.removeEventListener('scroll', place);
      input.removeEventListener('keyup', place);
      input.removeEventListener('select', place);
    };
  });
  return (
    <span ref={mirrorRef} className="composer-mirror" aria-hidden="true">
      {/* One inline box, so the text flows (and wraps) exactly like the field's own text. */}
      {/* A trailing new line needs a character after it to take up its line, as it does in the field. */}
      <span className="composer-mirror-text"><FormattedText text={text} markers />{text.endsWith('\n') ? '​' : ''}</span>
    </span>
  );
}
