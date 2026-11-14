// The running XMPP session (src/xmpp/session.js) for parts of the app outside App.jsx, such as group sending
// (GroupsView). null when this account does not use XMPP or it is not started.
let current = null;

export function setXmppSession(session) {
  current = session ?? null;
}

export function getXmppSession() {
  return current;
}
