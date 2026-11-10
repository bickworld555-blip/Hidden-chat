// Communities (WhatsApp): an announcement group plus related groups under one name. Admins add groups (existing
// ones they administer, or new ones); members see every group and can join them.
import { useCallback, useEffect, useState } from 'react';
import { Check, Megaphone, Pencil, Plus, Trash2, Unlink, Users } from 'lucide-react';
import * as api from '../../parityApi.js';
import { apiFetch } from '../../api.js';
import Panel, { Notice } from './Panel.jsx';

async function adminGroups(token) {
  const response = await apiFetch('/api/v1/groups', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return [];
  return (await response.json()).filter((group) => group.role === 'admin');
}

export default function CommunitiesView({ token, revision, onClose, onOpenGroup, inline = false }) {
  const [communities, setCommunities] = useState(null);
  const [view, setView] = useState({ name: 'list' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setCommunities(await api.listCommunities(token));
  }, [token]);
  useEffect(() => { refresh().catch((caught) => setError(caught.message)); }, [refresh, revision]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function run(action, message) {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (caught) {
      setError(caught.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const current = view.name === 'community' ? communities?.find((item) => item.id === view.id) : null;
  const back = view.name === 'list' ? null : () => setView({ name: 'list' });

  return (
    <Panel title={view.name === 'create' ? 'New community' : current ? current.name : 'Communities'} subtitle={current ? `Community · ${current.groups.length} groups` : undefined} onClose={onClose} onBack={back ?? undefined} inline={inline}>
      <Notice error={error} notice={notice} />
      {view.name === 'list' && (
        <>
          <button type="button" className="groups-new" onClick={() => setView({ name: 'create' })}>
            <span className="groups-new-icon"><Plus size={22} /></span><strong>New community</strong>
          </button>
          <p className="hm-muted hm-padded">Bring related groups together, and send announcements to everyone in them.</p>
          {communities === null && <p className="hm-muted hm-padded">Loading…</p>}
          {communities?.length === 0 && <p className="hm-empty">You’re not in any communities yet.</p>}
          {communities?.map((community) => (
            <button type="button" className="groups-list-row" key={community.id} onClick={() => setView({ name: 'community', id: community.id })}>
              <span className="hm-community-avatar" aria-hidden="true"><Users size={24} /></span>
              <span className="groups-list-copy">
                <span className="groups-list-top"><strong>{community.name}</strong></span>
                <span className="groups-list-bottom"><small>{community.groups.length} groups{community.role === 'admin' ? ' · Admin' : ''}</small></span>
              </span>
            </button>
          ))}
        </>
      )}
      {view.name === 'create' && <CreateCommunity token={token} busy={busy} onCreate={async (details) => {
        const created = await run(() => api.createCommunity(token, details), 'Community created.');
        if (created) setView({ name: 'community', id: created.id });
      }} />}
      {current && <CommunityDetails community={current} token={token} busy={busy} run={run} onOpenGroup={onOpenGroup} onDeleted={() => setView({ name: 'list' })} />}
    </Panel>
  );
}

function CreateCommunity({ token, busy, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [groups, setGroups] = useState([]);
  const [picked, setPicked] = useState([]);
  useEffect(() => { adminGroups(token).then((list) => setGroups(list.filter((group) => !group.communityId))).catch(() => {}); }, [token]);
  return (
    <form className="hm-form" onSubmit={(event) => { event.preventDefault(); onCreate({ name, description, groupIds: picked }); }}>
      <label>Community name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Description<textarea value={description} maxLength={2048} rows={3} onChange={(event) => setDescription(event.target.value)} placeholder="What is this community about?" /></label>
      <fieldset>
        <legend>Add groups you’re an admin of</legend>
        {groups.length === 0 && <p className="hm-muted">No groups to add. You can create new groups in the community later.</p>}
        {groups.map((group) => (
          <label key={group.id} className="hm-check-row">
            <input type="checkbox" checked={picked.includes(group.id)} onChange={() => setPicked((list) => (list.includes(group.id) ? list.filter((id) => id !== group.id) : [...list, group.id]))} />
            <span>{group.name}</span>
          </label>
        ))}
      </fieldset>
      <p className="hm-muted">An announcement group is created for the community. Only admins send messages there; everyone in the community’s groups receives them.</p>
      <button type="submit" className="groups-primary" disabled={busy || !name.trim()}>Create community</button>
    </form>
  );
}

function CommunityDetails({ community, token, busy, run, onOpenGroup, onDeleted }) {
  const isAdmin = community.role === 'admin';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description);
  const [adding, setAdding] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (adding) adminGroups(token).then((list) => setCandidates(list.filter((group) => !community.groups.some((item) => item.id === group.id)))).catch(() => {});
  }, [adding, token, community.groups]);
  const announcement = community.groups.find((group) => group.isAnnouncement);
  const others = community.groups.filter((group) => !group.isAnnouncement);

  return (
    <div className="hm-community">
      {editing ? (
        <form className="hm-form" onSubmit={(event) => { event.preventDefault(); run(() => api.updateCommunity(token, community.id, { name, description }), 'Community updated.').then(() => setEditing(false)); }}>
          <label>Community name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required /></label>
          <label>Description<textarea value={description} maxLength={2048} rows={3} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="hm-row-actions"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="groups-primary" disabled={busy}>Save</button></div>
        </form>
      ) : (
        <div className="hm-community-about">
          <p>{community.description || 'No description'}</p>
          {isAdmin && <button type="button" className="icon-button" onClick={() => setEditing(true)} aria-label="Edit community"><Pencil size={16} /></button>}
        </div>
      )}
      {announcement && (
        <button type="button" className="groups-list-row" onClick={() => onOpenGroup(announcement.id)}>
          <span className="hm-community-avatar is-announcement" aria-hidden="true"><Megaphone size={22} /></span>
          <span className="groups-list-copy"><span className="groups-list-top"><strong>Announcements</strong></span><span className="groups-list-bottom"><small>{announcement.memberCount} members · only admins send</small></span></span>
        </button>
      )}
      <h4 className="hm-section-title">Groups in this community</h4>
      {others.length === 0 && <p className="hm-muted hm-padded">No groups yet.</p>}
      {others.map((group) => (
        <div className="groups-list-row hm-community-group" key={group.id}>
          <span className="groups-avatar" aria-hidden="true"><Users size={20} /></span>
          <span className="groups-list-copy">
            <span className="groups-list-top"><strong>{group.name}</strong></span>
            <span className="groups-list-bottom"><small>{group.memberCount} members{group.description ? ` · ${group.description}` : ''}</small></span>
          </span>
          {group.role ? <button type="button" onClick={() => onOpenGroup(group.id)}>Open</button>
            : group.requested ? <span className="hm-muted">Requested</span>
              : <button type="button" className="groups-primary" disabled={busy} onClick={() => run(() => api.joinCommunityGroup(token, community.id, group.id), group.approveJoins ? 'Request sent to the group admins.' : `You joined ${group.name}.`)}>{group.approveJoins ? 'Ask to join' : 'Join'}</button>}
          {isAdmin && <button type="button" className="icon-button" aria-label={`Remove ${group.name} from the community`} disabled={busy} onClick={() => run(() => api.removeCommunityGroup(token, community.id, group.id), `${group.name} was removed from the community.`)}><Unlink size={16} /></button>}
        </div>
      ))}
      {isAdmin && (adding ? (
        <div className="hm-form">
          <form className="hm-inline-form" onSubmit={(event) => { event.preventDefault(); run(() => api.addCommunityGroup(token, community.id, { name: newGroup }), 'Group created.').then(() => { setNewGroup(''); setAdding(false); }); }}>
            <input value={newGroup} maxLength={100} onChange={(event) => setNewGroup(event.target.value)} placeholder="New group name" aria-label="New group name" />
            <button type="submit" className="groups-primary" disabled={busy || !newGroup.trim()}><Plus size={16} /> Create</button>
          </form>
          {candidates.map((group) => (
            <button type="button" className="groups-row" key={group.id} disabled={busy} onClick={() => run(() => api.addCommunityGroup(token, community.id, { groupId: group.id }), `${group.name} added.`).then(() => setAdding(false))}>
              <Users size={18} aria-hidden="true" /><span><strong>Add {group.name}</strong><small>A group you administer</small></span>
            </button>
          ))}
          <button type="button" onClick={() => setAdding(false)}>Done</button>
        </div>
      ) : <button type="button" className="groups-new" onClick={() => setAdding(true)}><span className="groups-new-icon"><Plus size={22} /></span><strong>Add groups</strong></button>)}
      {isAdmin && (confirmDelete ? (
        <div className="groups-confirm" role="group" aria-label="Confirm deactivating community">
          <p>Deactivate this community? Its groups stay, but they’re no longer linked, and the announcement group becomes a normal group.</p>
          <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button type="button" className="groups-danger" disabled={busy} onClick={() => run(() => api.deleteCommunity(token, community.id), 'Community deactivated.').then(onDeleted)}><Check size={16} /> Deactivate</button>
        </div>
      ) : <button type="button" className="hm-danger-row" onClick={() => setConfirmDelete(true)}><Trash2 size={18} /> Deactivate community</button>)}
    </div>
  );
}
