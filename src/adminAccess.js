// Whether this account may open the admin console (the server answers 404 to everyone else; server/admin.mjs).
import { request } from './parityApi.js';

export async function canAdminister(token) {
  try {
    await request(token, '/api/v1/admin/me');
    return true;
  } catch {
    return false;
  }
}
