import { getPostgresPool } from './database.mjs';

const INSERT_MESSAGE = `
  INSERT INTO public.messages (conversation_id, sender_id, content, attachment_url)
  VALUES ($1, $2, $3, $4)
  RETURNING id, conversation_id, sender_id, content, attachment_url, created_at
`;

function identifier(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function registerChatEvents(io, socket) {
  async function authorize(conversationId) {
    const userId = socket.data?.userId;
    if (!identifier(userId)) throw new Error('Authentication is required.');
    if (!identifier(conversationId)) throw new Error('A conversation ID is required.');
    const check = socket.data?.authorizeConversation;
    if (typeof check !== 'function' || await check(userId, conversationId) !== true) {
      throw new Error('Conversation access denied.');
    }
    if (!socket.connected) throw new Error('The socket disconnected.');
    return userId;
  }

  function report(event, error, message, savedMessageId = null) {
    console.error(`Chat event ${event} failed:`, error.code ?? error.name);
    socket.emit('message_error', {
      event,
      message,
      ...(savedMessageId ? { saved_message_id: savedMessageId } : {}),
    });
  }

  socket.on('join_conversation', async (conversationId) => {
    try {
      await authorize(conversationId);
      await socket.join(conversationId);
    } catch (error) {
      report('join_conversation', error, 'Could not join the conversation. Check your access and connection.');
    }
  });

  socket.on('send_message', async (data) => {
    let savedMessage = null;
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid message payload.');
      const { conversation_id, sender_id, content, attachment_url = null } = data;
      const userId = await authorize(conversation_id);
      if (sender_id !== userId) throw new Error('Sender does not match the authenticated user.');
      if (typeof content !== 'string' || content.length > 4000) throw new Error('Message content must be a string of at most 4000 characters.');
      if (attachment_url !== null && (!identifier(attachment_url))) throw new Error('Attachment URL must be a nonempty string or null.');
      if (!content.trim() && attachment_url === null) throw new Error('A message requires content or an attachment.');
      const result = await getPostgresPool().query(INSERT_MESSAGE, [
        conversation_id, userId, content, attachment_url,
      ]);
      savedMessage = result.rows[0];
      if (!savedMessage?.id) throw new Error('The database did not return a saved message.');
      io.to(conversation_id).emit('receive_message', savedMessage);
    } catch (error) {
      report('send_message', error, savedMessage
        ? 'Message saved, but live delivery failed. Refresh the conversation; do not resend.'
        : 'Could not send the message. Check your access and connection.',
      savedMessage?.id);
    }
  });

  socket.on('disconnect', (reason) => {
    console.info('Chat socket disconnected:', socket.id, reason);
  });
}
