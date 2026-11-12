// Whether this device can still save what arrives: the one place storage failures are classified and shown.
// SQLite ("database or disk is full", SQLITE_FULL), Android ("No space left on device", ENOSPC) and the browser
// (QuotaExceededError) all say "full" in their own words; anything else is reported as a failing store.
// Nothing is lost while it lasts: unsaved messages stay in memory and are not acknowledged, so the server keeps them.
import { useSyncExternalStore } from 'react';

const FULL = /SQLITE_FULL|database or disk is full|disk is full|no space left|ENOSPC|quota ?exceeded|exceeded the quota/i;

/** 'full' when the error means the phone (or the browser's share of it) has no room left; otherwise 'failing'. */
export function classifyStorageError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? error ?? ''} ${error?.code ?? ''}`;
  return error?.name === 'QuotaExceededError' || FULL.test(text) ? 'full' : 'failing';
}

let problem = null; // null | { kind: 'full' | 'failing', since, message }
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };

export function reportStorageFailure(error) {
  const kind = classifyStorageError(error);
  if (problem?.kind === kind) return;
  problem = { kind, since: Date.now(), message: String(error?.message ?? error ?? '').slice(0, 160) };
  emit();
}

export function reportStorageWorking() {
  if (!problem) return;
  problem = null;
  emit();
}

export const storageProblem = () => problem;

export function useStorageProblem() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, storageProblem, storageProblem);
}

/** The words the app shows for it. */
export function storageProblemText(current) {
  if (!current) return '';
  return current.kind === 'full'
    ? 'Your phone is out of storage. New messages wait safely on the server until there is room: free up some space to save them.'
    : 'Messages can’t be saved on this phone right now. They wait safely on the server and are saved as soon as this works again.';
}
