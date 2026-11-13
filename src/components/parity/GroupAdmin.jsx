// Group administration (WhatsApp's "Group settings", invite links and member management).
import { useEffect, useState } from 'react';
import { Check, Copy, EllipsisVertical, Link2, Pencil, RefreshCw, ShieldCheck, UserMinus, Users, X } from 'lucide-react';
import * as api from '../../parityApi.js';
import Avatar from '../Avatar.jsx';
import { inviteCodeFrom, inviteUrl } from '../../invites.js';

export { inviteCodeFrom, inviteUrl };

function Toggle({ title, detail, checked, disabled, onChange }) {
  return (
    <label className="groups-setting">
      <ShieldCheck size={22} className="groups-setting-icon" aria-hidden="true" />
      <span className="groups-setting-copy"><strong>{title}</strong><small>{detail}</small></span>
      <input type="checkbox" className="groups-switch-input" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={title} />
    </label>
  );
}

/** Description (everyone, or admins when restricted), permissions, invite link and join requests (admins). */
export function GroupAdminSettings({ group, token, onChanged, onNotice, onError }) {
  const isAdmin = group.role === 'admin';
  const canEditInfo = isAdmin || !group.onlyAdminsEdit;
  const [editingInfo, setEditingInfo] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isAdmin || !group.approveJoins && !group.pendingRequests) { setRequests([]); return; }
    api.listJoinRequests(token, group.id).then(setRequests).catch(() => setRequests([]));
  }, [isAdmin, group.id, group.approveJoins, group.pendingRequests, token]);

  async function run(action, notice) {
    setBusy(true);
    try {
      await action();
      if (notice) onNotice(notice);
      await onChanged();
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(group.inviteCode));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      onError('Copy the link by selecting it.');
    }
  };

  return (
    <div className="hm-group-admin">
      <section className="hm-group-about">
        {editingInfo ? (
          <form onSubmit={(event) => { event.preventDefault(); run(async () => { await api.updateGroupInfo(token, group.id, { name, description }); setEditingInfo(false); }, 'Group info saved.'); }}>
            <label>Group name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></label>
            <label>Description<textarea value={description} maxLength={2048} rows={3} onChange={(event) => setDescription(event.target.value)} placeholder="Add group description" /></label>
            <div className="hm-row-actions">
              <button type="button" onClick={() => { setEditingInfo(false); setName(group.name); setDescription(group.description ?? ''); }}>Cancel</button>
              <button type="submit" className="groups-primary" disabled={busy || !name.trim()}>Save</button>
            </div>
          </form>
        ) : (
          <button type="button" className="hm-group-description" disabled={!canEditInfo} onClick={() => setEditingInfo(true)}>
            <span>{group.description ? group.description : canEditInfo ? 'Add group description' : 'No description'}</span>
            {canEditInfo && <Pencil size={16} aria-label="Edit group info" />}
          </button>
        )}
      </section>

      {isAdmin && (
        <section aria-label="Group permissions">
          <h4>Group permissions</h4>
          <Toggle title="Only admins can send messages" detail={group.isAnnouncement ? 'Always on in a community’s announcement group' : 'Members can still read and react'}
            checked={group.onlyAdminsSend} disabled={busy || group.isAnnouncement}
            onChange={(value) => run(() => api.updateGroupPermissions(token, group.id, { onlyAdminsSend: value }), value ? 'Only admins can send messages now.' : 'Everyone can send messages now.')} />
          <Toggle title="Only admins can edit group info" detail="Name, description and pinned messages"
            checked={group.onlyAdminsEdit} disabled={busy}
            onChange={(value) => run(() => api.updateGroupPermissions(token, group.id, { onlyAdminsEdit: value }))} />
          <Toggle title="Approve new members" detail="People who join with a link wait for an admin"
            checked={group.approveJoins} disabled={busy}
            onChange={(value) => run(() => api.updateGroupPermissions(token, group.id, { approveJoins: value }))} />
        </section>
      )}

      {isAdmin && (
        <section aria-label="Invite via link">
          <h4><Link2 size={16} aria-hidden="true" /> Invite via link</h4>
          {group.inviteCode ? (
            <>
              <p className="hm-invite-link"><code>{inviteUrl(group.inviteCode)}</code></p>
              <div className="hm-row-actions">
                <button type="button" onClick={copyLink}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy link'}</button>
                <button type="button" disabled={busy} onClick={() => run(() => api.resetInvite(token, group.id), 'Link reset. The old link no longer works.')}><RefreshCw size={16} /> Reset link</button>
                <button type="button" className="groups-danger" disabled={busy} onClick={() => run(() => api.revokeInvite(token, group.id), 'Invite link turned off.')}><X size={16} /> Turn off</button>
              </div>
            </>
          ) : (
            <button type="button" className="groups-primary" disabled={busy} onClick={() => run(() => api.resetInvite(token, group.id), 'Invite link created.')}>Create invite link</button>
          )}
        </section>
      )}

      {isAdmin && requests.length > 0 && (
        <section aria-label="Pending members">
          <h4><Users size={16} aria-hidden="true" /> Pending members ({requests.length})</h4>
          {requests.map((person) => (
            <div className="groups-member" key={person.id}>
              <Avatar {...person} />
              <span><strong>{person.name}</strong><small>@{person.username}</small></span>
              <span className="hm-row-actions">
                <button type="button" disabled={busy} aria-label={`Reject ${person.name}`} onClick={() => run(() => api.answerJoinRequest(token, group.id, person.id, false))}><X size={16} /></button>
                <button type="button" className="groups-primary" disabled={busy} aria-label={`Approve ${person.name}`} onClick={() => run(() => api.answerJoinRequest(token, group.id, person.id, true), `${person.name} joined the group.`)}><Check size={16} /></button>
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** Admin actions for one member (make/dismiss admin, remove). */
export function MemberAdminActions({ group, member, userId, token, onChanged, onNotice, onError }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (group.role !== 'admin' || member.id === userId) return null;
  const isCreator = member.id === group.createdBy;
  async function run(action, notice) {
    setBusy(true);
    setOpen(false);
    try {
      await action();
      onNotice(notice);
      await onChanged();
    } catch (caught) {
      onError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="hm-member-admin">
      <button type="button" className="icon-button" disabled={busy} aria-expanded={open} aria-label={`Manage ${member.name}`} onClick={() => setOpen((value) => !value)}>
        <EllipsisVertical size={18} />
      </button>
      {open && (
        <ul className="hm-popover-menu" role="menu">
          {member.role === 'admin'
            ? !isCreator && <li><button type="button" role="menuitem" onClick={() => run(() => api.setMemberRole(token, group.id, member.id, 'member'), `${member.name} is no longer an admin.`)}>Dismiss as admin</button></li>
            : <li><button type="button" role="menuitem" onClick={() => run(() => api.setMemberRole(token, group.id, member.id, 'admin'), `${member.name} is now an admin.`)}>Make group admin</button></li>}
          {!isCreator && <li><button type="button" role="menuitem" className="danger" onClick={() => run(() => api.removeMember(token, group.id, member.id), `${member.name} was removed.`)}><UserMinus size={16} /> Remove {member.name}</button></li>}
        </ul>
      )}
    </span>
  );
}

/** "Join group?" for an invite link: preview, then join or ask to join. */
export function JoinGroupSheet({ code, token, onJoined, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    api.previewInvite(token, code).then((value) => { setPreview(value); setRequested(value.requested); }).catch((caught) => setError(caught.message));
  }, [code, token]);
  async function join() {
    setBusy(true);
    setError('');
    try {
      const result = await api.joinInvite(token, code);
      if (result.requested) setRequested(true);
      else onJoined(result.groupId);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wa-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="hm-sheet" role="dialog" aria-modal="true" aria-label="Join group" onClick={(event) => event.stopPropagation()}>
        {error && <p className="hm-error" role="alert">{error}</p>}
        {!preview && !error && <p className="hm-muted">Opening invite…</p>}
        {preview && (
          <div className="hm-join-preview">
            <span className="groups-avatar groups-avatar-large" aria-hidden="true"><Users size={36} /></span>
            <h3>{preview.name}</h3>
            <small>Group · {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}</small>
            {preview.description && <p>{preview.description}</p>}
            {preview.member ? (
              <button type="button" className="groups-primary" onClick={() => onJoined(preview.groupId)}>Open group</button>
            ) : requested ? (
              <>
                <p className="hm-muted">Request sent. An admin needs to approve it.</p>
                <button type="button" onClick={() => api.cancelJoinRequest(token, code).then(() => setRequested(false)).catch((caught) => setError(caught.message))}>Cancel request</button>
              </>
            ) : (
              <button type="button" className="groups-primary" disabled={busy} onClick={join}>{preview.approveJoins ? 'Request to join' : 'Join group'}</button>
            )}
          </div>
        )}
        <button type="button" className="hm-sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
