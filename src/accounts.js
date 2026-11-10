// Multiple signed-in accounts on one device. Each account keeps its own session token; one is active.
// Stored in IndexedDB; the legacy single `relay:session` record is migrated on first load.
import { useSyncExternalStore } from 'react';
// Session tokens are encrypted at rest (src/secureStorage.js).
import { secureDel as del, secureGet as get, secureSet as set } from './secureStorage.js';

export const ACCOUNTS_KEY = 'relay:accounts';
export const LEGACY_SESSION_KEY = 'relay:session';
export const MAX_ACCOUNTS = 5;

const listeners = new Set();
let state = { ready: false, activeId: null, accounts: [] };
let loading = null;

function emit(next) {
  state = next;
  for (const listener of listeners) listener();
}

export function accountFromSession(session) {
  if (!session?.token || !session?.user?.id) return null;
  return {
    id: session.user.id,
    token: session.token,
    deviceId: session.deviceId ?? session.device?.id ?? null,
    deviceName: session.deviceName ?? session.device?.name ?? null,
    user: session.user,
    lastActiveAt: Date.now(),
  };
}

export function sessionFromAccount(account) {
  if (!account) return null;
  return { token: account.token, deviceId: account.deviceId, deviceName: account.deviceName, user: account.user };
}

// Pure: adds or refreshes an account and makes it active, newest activity first, capped.
export function upsertAccountList(accounts, account) {
  const rest = accounts.filter((item) => item.id !== account.id);
  return [{ ...account, lastActiveAt: Date.now() }, ...rest].slice(0, MAX_ACCOUNTS);
}

// Pure: which account becomes active once one is removed (the most recently used remaining one).
export function nextActiveAfterRemoval(accounts, removedId, activeId) {
  const remaining = accounts.filter((item) => item.id !== removedId);
  if (activeId && activeId !== removedId && remaining.some((item) => item.id === activeId)) return activeId;
  return [...remaining].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]?.id ?? null;
}

async function persist(next) {
  await set(ACCOUNTS_KEY, { activeId: next.activeId, accounts: next.accounts });
  // The active session is mirrored to the legacy key so older code paths keep working.
  const active = next.accounts.find((item) => item.id === next.activeId);
  if (active) await set(LEGACY_SESSION_KEY, sessionFromAccount(active));
  else await del(LEGACY_SESSION_KEY);
}

export async function loadAccounts() {
  if (state.ready) return state;
  if (loading) return loading;
  loading = (async () => {
    let stored = await get(ACCOUNTS_KEY).catch(() => null);
    if (!stored) {
      const legacy = await get(LEGACY_SESSION_KEY).catch(() => null);
      const account = accountFromSession(legacy);
      stored = account ? { activeId: account.id, accounts: [account] } : { activeId: null, accounts: [] };
    }
    const accounts = Array.isArray(stored.accounts) ? stored.accounts.filter((item) => item?.id && item?.token) : [];
    const activeId = accounts.some((item) => item.id === stored.activeId) ? stored.activeId : accounts[0]?.id ?? null;
    emit({ ready: true, activeId, accounts });
    return state;
  })();
  return loading;
}

export function getAccountsState() {
  return state;
}

export async function addOrActivateAccount(session) {
  await loadAccounts();
  const account = accountFromSession(session);
  if (!account) return state;
  const next = { ready: true, activeId: account.id, accounts: upsertAccountList(state.accounts, account) };
  emit(next);
  await persist(next);
  return next;
}

export async function activateAccount(id) {
  await loadAccounts();
  const account = state.accounts.find((item) => item.id === id);
  if (!account) return null;
  const next = { ready: true, activeId: id, accounts: upsertAccountList(state.accounts, account) };
  emit(next);
  await persist(next);
  return account;
}

export async function removeAccount(id) {
  await loadAccounts();
  const activeId = nextActiveAfterRemoval(state.accounts, id, state.activeId);
  const next = { ready: true, activeId, accounts: state.accounts.filter((item) => item.id !== id) };
  emit(next);
  await persist(next);
  return next;
}

export async function updateAccountUser(user) {
  if (!user?.id || !state.accounts.some((item) => item.id === user.id)) return;
  const next = { ...state, accounts: state.accounts.map((item) => (item.id === user.id ? { ...item, user: { ...item.user, ...user } } : item)) };
  emit(next);
  await persist(next);
}

export function subscribeAccounts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccounts() {
  return useSyncExternalStore(subscribeAccounts, getAccountsState, getAccountsState);
}

// Test hook.
export function resetAccountsCache() {
  state = { ready: false, activeId: null, accounts: [] };
  loading = null;
}
