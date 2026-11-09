// The on-screen keyboard on phones. While it is open the app marks <html class="keyboard-open">, so the composer
// drops the navigation-bar padding it needs only when it sits at the very bottom of the screen (with the keyboard
// up that padding left a strip between the message box and the keyboard on some phones), and the page is kept
// from scrolling up under the header when Android brings the focused box into view.

const KEYBOARD_MIN_HEIGHT = 120;

function editable(element, body) {
  if (!element || element === body) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'color'].includes(element.type);
}

/** Whether the keyboard is open: a text box has focus and the visible area is clearly shorter than the window was. */
export function keyboardOpen({ focusedEditable, viewportHeight, fullHeight }) {
  return Boolean(focusedEditable) && fullHeight - viewportHeight >= KEYBOARD_MIN_HEIGHT;
}

export function watchKeyboard(win = typeof window === 'undefined' ? null : window) {
  if (!win?.visualViewport) return () => {};
  const root = win.document.documentElement;
  // The tallest the page has been with no text box focused: the height without a keyboard (rotation resets it).
  let fullHeight = win.visualViewport.height;
  let orientation = win.screen?.orientation?.type;
  const update = () => {
    const focused = editable(win.document.activeElement, win.document.body);
    if (win.screen?.orientation?.type !== orientation) {
      orientation = win.screen?.orientation?.type;
      fullHeight = win.visualViewport.height;
    }
    if (!focused) fullHeight = Math.max(win.visualViewport.height, win.innerHeight);
    // With the WebView resized to the space above the keyboard, the window itself shrinks too.
    const viewportHeight = Math.min(win.visualViewport.height, win.innerHeight);
    const open = keyboardOpen({ focusedEditable: focused, viewportHeight, fullHeight });
    root.classList.toggle('keyboard-open', open);
    // The app is a fixed full-height layout: any document scroll is the browser panning to the focused box,
    // which pushes the header off the top. Undo it; the layout already keeps the box above the keyboard.
    if (win.document.scrollingElement && win.document.scrollingElement.scrollTop !== 0) win.document.scrollingElement.scrollTop = 0;
  };
  win.visualViewport.addEventListener('resize', update);
  win.addEventListener('resize', update);
  win.addEventListener('focusin', update);
  win.addEventListener('focusout', () => win.setTimeout(update, 50));
  update();
  return () => {
    win.visualViewport.removeEventListener('resize', update);
    win.removeEventListener('resize', update);
    win.removeEventListener('focusin', update);
  };
}
