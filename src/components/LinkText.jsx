import { Fragment } from 'react';
import { splitLinks } from '../links.js';
import { nativeOpenExternal, nativeShell } from '../native.js';

// Message text with its web links tappable. In the Android app a link opens in the app that handles it (YouTube,
// Facebook, the browser) on top of Hidden Messenger, so Back comes straight back to the chat.
export default function LinkText({ text }) {
  const parts = splitLinks(text);
  if (!parts.some((part) => part.href)) return text;
  return parts.map((part, index) => (part.href ? (
    <a
      key={index}
      className="message-link"
      href={part.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        if (!nativeShell()) return;
        event.preventDefault();
        nativeOpenExternal(part.href);
      }}
    >
      {part.text}
    </a>
  ) : <Fragment key={index}>{part.text}</Fragment>));
}
