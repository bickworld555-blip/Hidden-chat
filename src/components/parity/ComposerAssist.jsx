// Suggestions shown above a composer: @mention candidates (groups) and /quick replies (business).
import { useMemo } from 'react';
import { Zap } from 'lucide-react';
import { useAccountData, quickReplyMatches } from '../../accountData.js';
import { activeMention, applyMention, mentionCandidates, splitMentions } from '../../mentions.js';
import Avatar from '../Avatar.jsx';
import LinkText from '../LinkText.jsx';

/**
 * Renders the matching suggestions for `text` at `caret` and calls onReplace(nextText, nextCaret) when one is
 * chosen. `members` enables mentions (groups only).
 */
export function ComposerAssist({ text, caret, members, userId, onReplace }) {
  const quickReplies = useAccountData((state) => state.quickReplies);
  const replies = useMemo(() => quickReplyMatches(text, quickReplies), [text, quickReplies]);
  const mention = members ? activeMention(text, caret ?? text.length) : null;
  const candidates = useMemo(() => (mention ? mentionCandidates(members, mention.query, { excludeId: userId }) : []), [mention?.query, mention?.start, members, userId]);

  if (replies.length) {
    return (
      <ul className="hm-composer-assist" role="listbox" aria-label="Quick replies">
        {replies.map((reply) => (
          <li key={reply.id}>
            <button type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => onReplace(reply.text, reply.text.length)}>
              <Zap size={16} aria-hidden="true" /><strong>/{reply.shortcut}</strong><span>{reply.text}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  if (mention && candidates.length) {
    return (
      <ul className="hm-composer-assist" role="listbox" aria-label="Mention someone">
        {candidates.map((member) => (
          <li key={member.id}>
            <button type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => {
              const next = applyMention(text, mention, member.username, caret ?? text.length);
              onReplace(next.text, next.caret);
            }}>
              <Avatar {...member} size="small" /><strong>{member.name}</strong><span>@{member.username}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

/** Message text with @mentions of known members highlighted (links stay links). */
export function MentionText({ text, usernames, ownUsername }) {
  const parts = useMemo(() => splitMentions(text ?? '', usernames), [text, usernames]);
  if (parts.length === 1 && parts[0].text !== undefined) return <LinkText text={text} />;
  return parts.map((part, index) => (part.mention
    ? <span key={index} className={`hm-mention${part.username === ownUsername?.toLowerCase() ? ' is-me' : ''}`}>{part.mention}</span>
    : <LinkText key={index} text={part.text} />));
}
