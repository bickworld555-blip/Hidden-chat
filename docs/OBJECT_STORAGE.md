# Attachments in Cloudflare R2

With `MEDIA_STORAGE=r2`, photos, videos, voice notes and files go **straight from the phone to an R2 bucket** and
are downloaded **straight from the bucket**. The app server only signs short-lived URLs, completes uploads, copies
forwards and deletes objects. The bytes are already end-to-end encrypted on the phone (`src/mediaCrypto.js`), so
the bucket holds ciphertext only. Without the setting, attachments stay on the server's disk as before.

## How it works

| Step | What happens |
|---|---|
| Upload | `POST /api/v1/uploads` with `direct: true` starts a multipart upload in the bucket. The phone asks for presigned part URLs (`POST /uploads/:id/parts`, 15 minutes each), PUTs 8 MiB parts to the bucket, then sends the parts' ETags to `/complete`. The server completes the upload, checks the stored size and records the attachment. |
| Download | `GET /api/v1/media/:id` checks who may read the attachment, then redirects (302) to a 5-minute bucket URL that names the file and its type. The app asks with `?locate=1` and fetches that URL without its session token. `HEAD` is answered by the server. |
| Forward | Copied inside the bucket (`CopyObject`). |
| Delete, cancel | Objects are deleted and unfinished multipart uploads are aborted, including by the stale-upload sweep. |
| View once voice | Streamed through the server once, then deleted (a bucket URL could be replayed until it expired). |

Clients without direct upload (older apps, the Android background upload service, single-request uploads) keep
using the server's disk; both kinds of attachment are served side by side (`media.storage`: `disk` or `r2`).

## Setup

1. **Create the bucket** in Cloudflare › R2, for example `hm-media`. Keep public access **off**: every read goes
   through a presigned URL.
2. **Create an API token** (R2 › Manage API tokens) with *Object Read & Write* on that bucket only. Note the Access
   Key ID, the Secret Access Key and your Account ID.
3. **Add the CORS rule** (bucket › Settings › CORS policy):

   ```json
   [
     {
       "AllowedOrigins": ["https://hiddenmessenger.com", "https://www.hiddenmessenger.com", "https://localhost"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Disposition", "Content-Type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   - `https://localhost` is the Android app's own origin (Capacitor). The desktop app loads the website, so it shares
     the website's origin.
   - **`ETag` must be exposed.** The app reads it from each part's answer to complete the upload. Without it uploads
     fail with "The storage bucket hides upload receipts (ETag)".
4. **Add a lifecycle rule** (bucket › Settings › Object lifecycle rules): *Abort incomplete multipart uploads after
   1 day*. This catches uploads abandoned while the server was unreachable.
5. **Set the environment** in hPanel (Node.js › Environment variables), then restart:

   ```
   MEDIA_STORAGE=r2
   R2_ACCOUNT_ID=<account id>
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   R2_BUCKET=hm-media
   ```

   A half-configured set stops the server at start-up with the missing names, rather than failing on the first upload.
6. **Android:** the app's Content-Security-Policy must allow `https://*.r2.cloudflarestorage.com`. That is already in
   `scripts/configure-android.mjs`, but it only takes effect in an APK built after it was added. Install a new APK
   before switching storage on, or Android uploads and downloads to the bucket will be blocked.

## Not covered yet

- Attachments already on disk stay there (they are served as before); there is no migration job yet.
- PDF page counts ("3 pages") are not read from bucket-stored files.
- Chat backups, profile photos and catalogue images stay on the server's disk.
- The Android background upload service (`UploadService.java`) still uploads through the server.
