// Live formatting in the message box. The input stays a normal <input> (typing, IME, caret, selection,
// autofill all native); when the text has formatting markers, its own glyphs turn transparent and this layer
// behind it draws the same text with the markers dimmed and the styles applied. Every style keeps the plain
// text's width (bold is a stroke, italic a skew, code a tint), and the layer copies the input's font, padding
// and horizontal scroll, so the caret stays on the right character.
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
    mirror.style.left = `${input.offsetLeft}px`;
    mirror.style.top = `${input.offsetTop}px`;
    mirror.style.width = `${input.offsetWidth}px`;
    mirror.style.height = `${input.offsetHeight}px`;
    const sync = () => { mirror.scrollLeft = input.scrollLeft; };
    sync();
    input.addEventListener('scroll', sync);
    input.addEventListener('keyup', sync);
    input.addEventListener('select', sync);
    const frame = requestAnimationFrame(sync);
    return () => {
      cancelAnimationFrame(frame);
      input.removeEventListener('scroll', sync);
      input.removeEventListener('keyup', sync);
      input.removeEventListener('select', sync);
    };
  });
  return (
    <span ref={mirrorRef} className="composer-mirror" aria-hidden="true">
      <FormattedText text={text} markers />
    </span>
  );
}
