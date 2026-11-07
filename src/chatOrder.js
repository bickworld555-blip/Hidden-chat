// Chat list ordering: pinned chats first, then favourites, then everything else; each band keeps
// the store's recency order (newest activity first).
export function orderChats(chats, { pinnedChatIds = [], favouriteChatIds = [] } = {}) {
  const pinned = new Set(pinnedChatIds);
  const favourites = new Set(favouriteChatIds);
  const band = (chat) => (pinned.has(chat.id) ? 0 : favourites.has(chat.id) ? 1 : 2);
  return chats
    .map((chat, index) => ({ chat, index, band: band(chat) }))
    .sort((left, right) => left.band - right.band || left.index - right.index)
    .map(({ chat }) => chat);
}
