// The small slice of XML that XMPP over WebSocket (RFC 7395) needs: every frame is one complete element, with no
// DTDs, comments, processing instructions or CDATA sections (XMPP forbids them). Parsed elements are plain objects:
//   { name, attrs: { [name]: value }, children: [element], text }
// `name` keeps any prefix ("stream:features"); `local(el)` strips it.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text or an attribute value made safe to put inside XML. */
export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, code) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return ENTITIES[code] ?? whole;
  });
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /\s*/y;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')\s*/y;

/** Parses one XML element (a WebSocket frame). Returns null for anything that is not one well-formed element. */
export function parseXml(source) {
  if (typeof source !== 'string' || source.length > 1_000_000) return null;
  let at = 0;
  const skip = () => { SPACE.lastIndex = at; SPACE.exec(source); at = SPACE.lastIndex; };
  function element() {
    if (source[at] !== '<') return null;
    at += 1;
    NAME.lastIndex = at;
    const name = NAME.exec(source)?.[0];
    if (!name) return null;
    at = NAME.lastIndex;
    const el = { name, attrs: {}, children: [], text: '' };
    for (;;) {
      skip();
      if (source.startsWith('/>', at)) { at += 2; return el; }
      if (source[at] === '>') { at += 1; break; }
      ATTRIBUTE.lastIndex = at;
      const match = ATTRIBUTE.exec(source);
      if (!match) return null;
      el.attrs[match[1]] = unescapeXml(match[3] ?? match[4] ?? '');
      at = ATTRIBUTE.lastIndex;
    }
    for (;;) {
      const next = source.indexOf('<', at);
      if (next < 0) return null;
      if (next > at) el.text += unescapeXml(source.slice(at, next));
      at = next;
      if (source.startsWith('</', at)) {
        const end = `</${name}`;
        if (!source.startsWith(end, at)) return null;
        at += end.length;
        skip();
        if (source[at] !== '>') return null;
        at += 1;
        return el;
      }
      const child = element();
      if (!child) return null;
      el.children.push(child);
    }
  }
  skip();
  const root = element();
  skip();
  return root && at === source.length ? root : null;
}

/** The name without its prefix ("stream:features" -> "features"). */
export const local = (el) => (el?.name ?? '').split(':').pop();

/** The first child with this local name (and namespace, when given). */
export function child(el, name, xmlns) {
  return el?.children?.find((item) => local(item) === name && (!xmlns || item.attrs.xmlns === xmlns)) ?? null;
}

// Built markup. Plain strings given to xml() are always text (escaped); Markup is nested as it is.
class Markup {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/** Builds an element: String(xml('message', { to, id }, [xml('body', {}, 'hi')])). Children: text strings or xml(). */
export function xml(name, attrs = {}, children = []) {
  const attributes = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  const list = (Array.isArray(children) ? children : [children]).filter((item) => item !== null && item !== undefined && item !== false);
  const body = list.map((item) => (item instanceof Markup ? item.text : escapeXml(item))).join('');
  return new Markup(body ? `<${name}${attributes}>${body}</${name}>` : `<${name}${attributes}/>`);
}
