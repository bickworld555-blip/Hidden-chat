// Set once the first-launch permissions walkthrough has been shown on this device. The phone app moved to v2
// when it started asking for the full set (contacts, SMS, phone, media…), so phones see the walkthrough once more.
import { nativeShell } from './native.js';

export const PERMISSIONS_ASKED_KEY = 'hm:permissions-asked-v1';
export const NATIVE_PERMISSIONS_ASKED_KEY = 'hm:permissions-asked-v2';
export const permissionsAskedKey = () => (nativeShell() ? NATIVE_PERMISSIONS_ASKED_KEY : PERMISSIONS_ASKED_KEY);
