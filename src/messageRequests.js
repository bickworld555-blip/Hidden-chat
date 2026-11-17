// Message requests (Signal's model): a 1:1 chat that someone else started, with someone I have not saved, named or
// accepted, is a request. Until I accept it (Accept, Add to contacts, or replying), they are not told that their
// messages were delivered or read:
// - through the server: it withholds "delivered" and "read" for an unaccepted link (server/index.mjs hasAccepted), and
//   this app holds back its read markers;
// - over XMPP (device to device): this app and the background page hold the delivery receipts and read markers
//   (src/xmpp/session.js holdReceiptsFor / releaseReceipts).
// Chats from before message requests, chats I started and saved contacts are never requests.

/** Whether this chat is an open message request. `accepted` is false only for a chat the other person started. */
export function isMessageRequest(chat) {
  return Boolean(chat) && !chat.group && !chat.deleted && chat.accepted === false && chat.saved !== true && !chat.alias;
}

/** Whether receipts to `peerId` must wait: an open request, or someone not in my lists at all (a first message). */
export function holdsReceipts(peerId, chats = []) {
  if (!peerId) return false;
  const chat = (chats ?? []).find((row) => row?.id === peerId);
  return chat ? isMessageRequest(chat) : true;
}
