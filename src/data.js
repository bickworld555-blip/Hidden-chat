export const demoUsers = [
  { id: 'ava', name: 'Ava Morgan', username: 'ava', initials: 'AM', color: 'coral', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=160&q=85' },
  { id: 'jordan', name: 'Jordan Lee', username: 'jordan', initials: 'JL', color: 'blue', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=160&q=85' },
  { id: 'nia', name: 'Nia Carter', username: 'nia', initials: 'NC', color: 'green', avatar: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=160&q=85' },
  { id: 'theo', name: 'Theo Park', username: 'theo', initials: 'TP', color: 'yellow', avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=160&q=85' },
  { id: 'studio', name: 'Studio North', username: 'studio', initials: 'SN', color: 'violet', avatar: null },
];

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

export const demoChats = [
  { id: 'ava', name: 'Ava Morgan', initials: 'AM', color: 'coral', avatar: demoUsers[0].avatar, preview: 'Start a conversation', time: '', unread: 0, online: false },
  { id: 'jordan', name: 'Jordan Lee', initials: 'JL', color: 'blue', avatar: demoUsers[1].avatar, preview: 'The new draft is looking sharp. Sent the link over.', time: '10:42', unread: 2, online: true },
  { id: 'nia', name: 'Nia Carter', initials: 'NC', color: 'green', avatar: demoUsers[2].avatar, preview: 'Coffee on Thursday? I found a spot near the studio.', time: '09:18', unread: 0, online: true },
  { id: 'studio', name: 'Studio North', initials: 'SN', color: 'violet', avatar: null, preview: 'Mika: moodboard is in the shared folder', time: 'Yesterday', unread: 0, online: false, group: true, members: 'You, Nia, Theo, Mika' },
  { id: 'theo', name: 'Theo Park', initials: 'TP', color: 'yellow', avatar: demoUsers[3].avatar, preview: 'That little animation detail makes it feel alive.', time: 'Tue', unread: 0, online: false },
];

export const initialMessages = {
  jordan: [
    { id: 'j-1', senderId: 'jordan', receiverId: 'ava', timestamp: ago(92), content: 'Hey Ava, how is the launch page coming along?', status: 'read' },
    { id: 'j-2', senderId: 'ava', receiverId: 'jordan', timestamp: ago(89), content: 'Just finished the first pass. The new layout is finally clicking.', status: 'read' },
    { id: 'j-3', senderId: 'jordan', receiverId: 'ava', timestamp: ago(86), content: 'Nice. The warmer color direction feels much more like us.', status: 'read' },
    { id: 'j-4', senderId: 'ava', receiverId: 'jordan', timestamp: ago(80), content: 'Agreed. I kept the type quiet and let the photos do the talking.', status: 'read' },
    { id: 'j-5', senderId: 'jordan', receiverId: 'ava', timestamp: ago(4), content: 'The new draft is looking sharp. Sent the link over.', status: 'read' },
    { id: 'j-6', senderId: 'jordan', receiverId: 'ava', timestamp: ago(3), content: 'Could you check the mobile spacing before standup?', status: 'read' },
  ],
  nia: [
    { id: 'n-1', senderId: 'nia', receiverId: 'ava', timestamp: ago(95), content: 'Morning! I added those references to the board.', status: 'read' },
    { id: 'n-2', senderId: 'ava', receiverId: 'nia', timestamp: ago(91), content: 'Perfect, thank you. The second one is exactly the right energy.', status: 'read' },
    { id: 'n-3', senderId: 'nia', receiverId: 'ava', timestamp: ago(44), content: 'Coffee on Thursday? I found a spot near the studio.', status: 'read' },
  ],
  studio: [
    { id: 's-1', senderId: 'nia', receiverId: 'ava', timestamp: ago(1300), content: 'Sharing the first pass here for everyone.', status: 'read' },
    { id: 's-2', senderId: 'ava', receiverId: 'nia', timestamp: ago(1285), content: 'The direction is strong. Let’s keep the layout open and give the work room.', status: 'read' },
    { id: 's-3', senderId: 'theo', receiverId: 'ava', timestamp: ago(1200), content: 'Mika: moodboard is in the shared folder', status: 'read' },
  ],
  theo: [
    { id: 't-1', senderId: 'ava', receiverId: 'theo', timestamp: ago(3600), content: 'I put the motion notes in the project doc.', status: 'read' },
    { id: 't-2', senderId: 'theo', receiverId: 'ava', timestamp: ago(3500), content: 'That little animation detail makes it feel alive.', status: 'read' },
  ],
};
