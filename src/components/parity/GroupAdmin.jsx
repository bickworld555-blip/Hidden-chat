// Group administration (WhatsApp's "Group settings", invite links and member management).
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, EllipsisVertical, Link2, Pencil, QrCode, RefreshCw, Share2, ShieldCheck, UserMinus, Users, X } from 'lucide-react';
import { shareText } from '../../share.js';
import GroupPhoto from '../GroupPhoto.jsx';
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

/** Description (everyone, or admins when restricted) and join requests (admins). Permissions and the invite link have their own screens below. */
export function GroupAdminSettings({ group, token, onChanged, onNotice, onError }) {
  const isAdmin = group.role === 'admin';
  const canEditInfo = isAdmin || !group.onlyAdminsEdit;
  const [editingInfo, setEditingInfo] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState([]);

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

// One busy flag and error/notice reporting for an admin action, then a refresh of the group.
function useGroupAction({ onChanged, onNotice, onError }) {
  const [busy, setBusy] = useState(false);
  const run = async (action, notice) => {
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
  };
  return [busy, run];
}

function ScreenHeader({ title, subtitle, onBack }) {
  return (
    <header className="wa-sc-header">
      <button type="button" className="wa-sc-back" onClick={onBack} aria-label="Back"><ArrowLeft size={22} /></button>
      <div className="wa-sc-title-wrap"><h2>{title}</h2>{subtitle && <span className="wa-sc-subtitle">{subtitle}</span>}</div>
    </header>
  );
}

/**
 * Group permissions (admins), laid out as WhatsApp's: "Members can:" edit group settings, send new messages, add other
 * members; "Admins can:" approve new members; "Group admins": edit group admins.
 */
export function GroupPermissionsScreen({ group, token, onBack, onChanged, onNotice, onError }) {
  const [busy, run] = useGroupAction({ onChanged, onNotice, onError });
  const [editingAdmins, setEditingAdmins] = useState(false);
  const set = (change, notice) => run(() => api.updateGroupPermissions(token, group.id, change), notice);
  const adminCount = (group.members ?? []).filter((member) => member.role === 'admin').length;
  return (
    <div className="ng-screen" role="dialog" aria-modal="true" aria-label="Group permissions">
      <ScreenHeader title="Group permissions" subtitle={group.name} onBack={onBack} />
      <div className="wa-sc-scroll-body ng-scroll hm-permissions">
        <p className="hm-group-admin-label">Members can:</p>
        <Toggle title="Edit group settings" detail="This includes the name, photo, description and disappearing messages, and pinning messages."
          checked={!group.onlyAdminsEdit} disabled={busy} onChange={(value) => set({ onlyAdminsEdit: !value })} />
        <Toggle title="Send new messages" detail={group.isAnnouncement ? 'Always off in a community’s announcement group.' : ''}
          checked={!group.onlyAdminsSend} disabled={busy || group.isAnnouncement}
          onChange={(value) => set({ onlyAdminsSend: !value }, value ? 'Everyone can send messages now.' : 'Only admins can send messages now.')} />
        <Toggle title="Add other members" detail="" checked={Boolean(group.membersCanAdd)} disabled={busy} onChange={(value) => set({ membersCanAdd: value })} />
        <p className="hm-group-admin-label">Admins can:</p>
        <Toggle title="Approve new members" detail="When turned on, admins must approve anyone who wants to join this group."
          checked={group.approveJoins} disabled={busy} onChange={(value) => set({ approveJoins: value })} />
        <p className="hm-group-admin-label">Group admins</p>
        <button type="button" className="groups-setting hm-group-admins-toggle" onClick={() => setEditingAdmins((open) => !open)} aria-expanded={editingAdmins}>
          <ShieldCheck size={22} className="groups-setting-icon" aria-hidden="true" />
          <span className="groups-setting-copy"><strong>Edit group admins</strong><small>{adminCount} {adminCount === 1 ? 'admin' : 'admins'}</small></span>
        </button>
        {editingAdmins && (
          <ul className="hm-group-admins" aria-label="Group admins">
            {(group.members ?? []).map((member) => {
              const admin = member.role === 'admin';
              const locked = member.id === group.createdBy;
              return (
                <li key={member.id}>
                  <label>
                    <input type="checkbox" checked={admin} disabled={busy || locked}
                      onChange={() => run(() => api.setMemberRole(token, group.id, member.id, admin ? 'member' : 'admin'), admin ? `${member.name} is no longer an admin.` : `${member.name} is now an admin.`)} />
                    <Avatar {...member} size="small" />
                    <span><strong>{member.name}</strong><small>{locked ? 'Group creator' : admin ? 'Admin' : 'Member'}</small></span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Group link (admins), as WhatsApp lays it out: the group with its link, then Copy link, Share link, QR code and Reset
 * link (and turning the link off), then "Manage permissions" with Edit. Without a link, one button creates it.
 */
export function GroupLinkScreen({ group, token, onBack, onChanged, onNotice, onError, onShowQr, onEditPermissions }) {
  const [busy, run] = useGroupAction({ onChanged, onNotice, onError });
  const link = group.inviteCode ? inviteUrl(group.inviteCode) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); onNotice('Link copied.'); } catch { onError('Copy the link by selecting it.'); }
  };
  const share = async () => {
    try {
      if (await shareText({ title: group.name, text: `Follow this link to join my Hidden Messenger group "${group.name}"`, url: link }) === 'copied') onNotice('Link copied.');
    } catch { onError('Sharing isn’t available here. Copy the link instead.'); }
  };
  const actions = [
    [Copy, 'Copy link', copy],
    [Share2, 'Share link', share],
    [QrCode, 'QR code', onShowQr],
    [RefreshCw, 'Reset link', () => run(() => api.resetInvite(token, group.id), 'Link reset. The old link no longer works.')],
    [X, 'Turn off link', () => run(() => api.revokeInvite(token, group.id), 'Invite link turned off.')],
  ];
  return (
    <div className="ng-screen" role="dialog" aria-modal="true" aria-label="Group link">
      <ScreenHeader title="Group link" onBack={onBack} />
      <div className="wa-sc-scroll-body ng-scroll">
        {link ? (
          <>
            <div className="hm-link-card">
              <GroupPhoto image={group.avatar} className="groups-avatar" iconSize={22} />
              <span><strong>{group.name}</strong><small>{link}</small></span>
            </div>
            {actions.map(([Icon, title, onClick]) => (
              <button type="button" key={title} className={`groups-setting hm-link-action ${title === 'Turn off link' ? 'is-danger' : ''}`} onClick={onClick} disabled={busy}>
                <Icon size={22} className="groups-setting-icon" aria-hidden="true" /><span className="groups-setting-copy"><strong>{title}</strong></span>
              </button>
            ))}
          </>
        ) : (
          <div className="hm-link-empty">
            <p>Anyone with Hidden Messenger can follow a group link to join this group. Only share it with people you trust.</p>
            <button type="button" className="groups-primary" disabled={busy} onClick={() => run(() => api.resetInvite(token, group.id), 'Invite link created.')}>Create invite link</button>
          </div>
        )}
        <div className="wa-sc-section-heading hm-link-manage">
          <span>Manage permissions</span>
          <button type="button" className="hm-link-edit" onClick={onEditPermissions}>Edit</button>
        </div>
        <p className="hm-link-info">{group.approveJoins ? 'Admins approve new members who join with the link.' : 'Anyone with the link can join without an admin’s approval.'}</p>
        <p className="hm-link-info">{group.membersCanAdd ? 'Members can add other members.' : 'Only admins can add other members.'}</p>
      </div>
    </div>
  );
}
