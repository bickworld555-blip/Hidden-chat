# Play Console: Data safety answers

These are the answers for **Play Console › App content › Data safety**, matching the code as of schema 27 and
the privacy policy at hiddenmessenger.com/privacy (`PRIVACY_ROWS` in `src/site/PublicSite.jsx`). Change all
three together.

## Data collection and security

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes (HTTPS and WSS only; `usesCleartextTraffic="false"`) |
| Do you provide a way for users to request that their data is deleted? | Yes: in the app (Settings › Account › Delete account) and at https://hiddenmessenger.com/delete-account |

## Data types

"Collected" means it leaves the phone and the server keeps it. The things Hidden Messenger never
collects are listed at the end.

| Category › type | Collected | Shared | Optional? | Purposes | What it is |
| --- | --- | --- | --- | --- | --- |
| Personal info › Name | Yes | No | Required | App functionality | Display name |
| Personal info › User IDs | Yes | No | Required | App functionality, Account management | Account id and @username |
| Personal info › Other info | Yes | No | Required | App functionality (age check) | Date of birth, used to check the minimum age |
| Location › Approximate location | Yes | No | Required | Analytics | Country worked out from the phone's time zone (no GPS, no IP address) |
| Messages › Other in-app messages | Yes | No | Optional | Customer support, App functionality | Messages to Hidden Messenger Support. Business auto-replies (away and greeting), written by business accounts |
| Photos and videos › Photos | Yes | No | Optional | App functionality | Profile photo, business cover photo and catalogue images (not end-to-end encrypted, because they are shown to other people by the server) |
| App activity › Other user-generated content | Yes | No | Optional | App functionality | About text, business profile (category, description, address, website, links), catalogue |
| App activity › Other actions | Yes | No | Required | App functionality | Contacts added in the app, group memberships, last seen and read receipts (each with its privacy setting) |
| Device or other IDs | Yes | No | Required | App functionality | Firebase Cloud Messaging push token |

**End-to-end encrypted content.** This covers messages, photos, videos, voice notes, files, shared locations,
reactions, poll votes and statuses. It is encrypted on the sender's phone, and the server stores only ciphertext it
cannot read. A strict production server refuses anything readable (`server/strictE2E.mjs`). The server deletes it
once every device has it, and after 30 days at most.

Before answering, read Google's current Data safety help for end-to-end encrypted data. If it still says such data
need not be declared, leave these types undeclared. If unsure, declare Messages, Photos and videos, Audio and
Location › Precise location as **collected, optional, for App functionality**. Note in the description that they
are end-to-end encrypted.

**Firebase Cloud Messaging** acts as a service provider, so it is not "sharing". The push payload carries no message text: for a sealed message, `server/index.mjs` sends only the
`e2e2:` marker, and the phone fetches and decrypts the message itself.

## Not collected, and why

| Data | Why it can't be collected |
| --- | --- |
| Phone number | No field exists. `server/no-identifiers.test.mjs` fails if a phone column is added. |
| Email address | No field exists, not even for businesses (dropped in migration 027). The same test guards it. |
| Contacts (address book) | The app has no `READ_CONTACTS` permission. The test checks the merged manifest. Invites are links shared through the Android share sheet. |
| Precise location (outside chats) | Location is read only when the user shares it in a chat, and then it is end-to-end encrypted. |
| SMS, call logs, installed apps, advertising ID | No permission and no code for them |
| Web browsing, search history, health, financial info | Not used. Business catalogue prices are product listings, not payment data. |

## When to update

Update this file, the privacy policy rows and the Play Console form whenever one of these changes:

- a new column holds personal data;
- a new permission is added;
- something starts leaving the phone unencrypted.
