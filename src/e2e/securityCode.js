// What the Encryption screen of a chat shows (ContactInfoDrawer): the 60-digit security code when both sides have
// devices this phone encrypts to, and otherwise which of several different things is the case. They used to share one
// line ("a security code appears once <name> opens an updated Hidden Messenger"), which blamed the contact's app for
// a lookup that failed, for this device not being on its own account's list, and for encryption still starting here.
//
// status:
//   'ok'              code: the 60 digits
//   'starting'        encryption has not started on this device yet (no session)
//   'offline'         the device lists could not be fetched (network, server)
//   'peer-no-keys'    the contact has no device with keys the server lists: never opened an app with encryption, or not
//                     used for so long that the server stopped listing its devices
//   'peer-unverified' the contact has devices, but their signed device list did not check out (so nothing is sealed
//                     for them)
//   'own-no-keys' / 'own-unverified'   the same, for this account's own devices
export const SECURITY_CODE_STATES = Object.freeze(['ok', 'starting', 'offline', 'peer-no-keys', 'peer-unverified', 'own-no-keys', 'own-unverified']);

/**
 * `report(userId)` resolves { devices: trusted devices, listed: how many the server listed } or rejects when the list
 * could not be fetched; `safetyNumber(mine, theirs)` computes the code from identities.
 */
export async function resolveSecurityCode({ hasSession, ownId, peerId, report, safetyNumber }) {
  if (!hasSession) return { status: 'starting' };
  let mine;
  let theirs;
  try {
    [mine, theirs] = await Promise.all([report(ownId), report(peerId)]);
  } catch {
    return { status: 'offline' };
  }
  if (!theirs.devices.length) return { status: theirs.listed > 0 ? 'peer-unverified' : 'peer-no-keys' };
  if (!mine.devices.length) return { status: mine.listed > 0 ? 'own-unverified' : 'own-no-keys' };
  let code = '';
  try {
    code = await safetyNumber(mine.devices.map((device) => device.identity), theirs.devices.map((device) => device.identity));
  } catch {
    return { status: 'offline' };
  }
  return code ? { status: 'ok', code } : { status: 'offline' };
}

/** The screen's wording for each state: { encrypted, text }. `name`: the contact as this user sees them. */
export function securityCodeMessage(status, name) {
  switch (status) {
    case 'ok':
      return { encrypted: true, text: `Messages and calls in this chat are end-to-end encrypted. Only your devices and ${name}'s can read or hear them; the server keeps only ciphertext it cannot read.` };
    case 'starting':
      return { encrypted: false, text: 'Encryption is still starting on this device. Try again in a moment.' };
    case 'offline':
      return { encrypted: false, text: 'The security code could not be loaded: the server could not be reached. Your messages stay end-to-end encrypted; check your connection and try again.' };
    case 'peer-unverified':
      return { encrypted: false, text: `${name}'s list of devices did not pass its signature check, so this device will not encrypt to it and your messages wait. Ask ${name} to open Hidden Messenger; if this stays, compare security codes in person before trusting this chat.` };
    case 'own-no-keys':
    case 'own-unverified':
      return { encrypted: false, text: 'This device is not on your account\'s signed list of devices yet, so there is no security code to compare here. Open Hidden Messenger on your phone and link this device again.' };
    case 'peer-no-keys':
    default:
      return { encrypted: false, text: `${name} has no device with encryption keys right now: they have not opened a Hidden Messenger with encryption yet, or have not used it for a long time. Messages you send wait on this device and go out end-to-end encrypted when ${name} opens the app. Nothing is sent unencrypted.` };
  }
}
