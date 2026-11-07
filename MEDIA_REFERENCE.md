# Media System Implementation Reference

## Quick Facts

| Aspect | Details |
|--------|---------|
| **Max File Size** | 10 MB (configured in server) |
| **Supported Formats** | Any format (PDF, JPG, PNG, MP3, MP4, ZIP, etc.) |
| **Storage Location** | `.data/media/` directory on server |
| **Filename Encoding** | URL-encoded in message, RFC 5987 in download |
| **Authentication** | Bearer token in Authorization header |
| **Content-Type** | Extracted from upload, stored in DB, returned in download |
| **Blob URLs** | Created for HTML element compatibility, revoked after use |

## File Upload Flow

```
User selects file
    ↓
MessageInput component → sendAttachment(file)
    ↓
ChatWindow.sendAttachment():
  - POST to /api/v1/media?receiverId=...
  - Headers:
    * Authorization: Bearer ${token}
    * Content-Type: application/octet-stream
    * X-File-Name: encodeURIComponent(file.name)
  - Body: file data (binary)
    ↓
Server /api/v1/media endpoint:
  - requireSession middleware validates token
  - Extract filename from X-File-Name header
  - Generate UUID as media ID
  - Write file to disk: .data/media/{uuid}.blob
  - Store metadata in DB:
    * id (UUID)
    * sender_id, receiver_id
    * filename (original name)
    * content_type (MIME type)
    * byte_size
    * disk_name (uuid.blob)
  - Return: { id, filename, contentType, byteSize }
    ↓
ChatWindow.sendMessage():
  - Format: media:{id}:{encodeURIComponent(filename)}
  - Send via WebSocket to receiver
```

## File Download/View Flow

```
User clicks image/PDF in chat
    ↓
MessageBubble renders MediaRenderer:
  - Parse message: media[0]=id, media[1]=encoded_filename
  - Decode filename: decodeURIComponent(media[1])
  - Pass to appropriate component (ImagePreview, DocumentCard, etc.)
    ↓
Component (e.g., DocumentCard.handleOpen()):
  - Fetch /api/v1/media/{id}
  - Headers: Authorization: Bearer ${sessionToken}
    ↓
Server /api/v1/media/:id endpoint:
  - requireSession middleware validates token
  - Query: SELECT filename, content_type, disk_name WHERE id=?
  - Read file from disk
  - Set headers:
    * Content-Type: media.contentType (from DB)
    * Content-Disposition: attachment; filename*=UTF-8''...encoded_filename...
    * X-Content-Type-Options: nosniff
    * Cache-Control: private, no-store
  - Send file binary data
    ↓
Component receives blob:
  - Create blob URL: URL.createObjectURL(blob)
  - For images: <img src={blobUrl} />
  - For PDFs: window.open(blobUrl) or <iframe src={blobUrl} />
  - For audio: <audio src={blobUrl} />
  - For download: <a href={blobUrl} download={filename} />
    ↓
Browser displays file with original filename/format
    ↓
Cleanup: setTimeout(() => URL.revokeObjectURL(url), 100)
```

## Authorization Header Pattern

### In ChatWindow.jsx
```javascript
// Where token is from Zustand store:
const token = useChatStore((state) => state.sessionToken);

// In fetch calls:
fetch(url, {
  headers: { 
    Authorization: `Bearer ${token}`,
    // ... other headers
  }
})
```

### In MediaRenderer.jsx
```javascript
// sessionToken is passed as prop from ChatWindow:
function DocumentCard({ mediaId, filename, sessionToken, ... }) {
  // In fetch calls:
  fetch(`/api/v1/media/${mediaId}`, {
    headers: { Authorization: `Bearer ${sessionToken}` }
  })
}
```

## MIME Type Mappings

```javascript
const mimeTypes = {
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  
  // Images
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'm4a': 'audio/mp4',
  'flac': 'audio/flac',
  
  // Video
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  
  // Archives
  'zip': 'application/zip',
  'rar': 'application/x-rar-compressed',
  
  // Fallback
  'default': 'application/octet-stream'
};
```

## Database Schema

```sql
CREATE TABLE media (
  id TEXT PRIMARY KEY,              -- UUID
  sender_id TEXT NOT NULL,          -- User who uploaded
  receiver_id TEXT NOT NULL,        -- User who will receive
  filename TEXT NOT NULL,           -- Original filename (e.g., "TK_TXN_05_11_26.pdf")
  content_type TEXT NOT NULL,       -- MIME type (e.g., "application/pdf")
  byte_size INTEGER NOT NULL,       -- File size in bytes
  disk_name TEXT NOT NULL,          -- Filename on disk (e.g., "abc123-def456.blob")
  created_at INTEGER NOT NULL       -- Timestamp
);
```

## Common Issues & Solutions

### Issue: "Failed to load image"
**Solution**: Check Authorization header has Bearer token (not `*****`)
```javascript
// Wrong:
{ Authorization: `*****` }

// Right:
{ Authorization: `Bearer ${token}` }
```

### Issue: Download has wrong filename (shows UUID)
**Solution**: Ensure filename is URL-decoded before use
```javascript
// Wrong:
link.download = media[1];  // still encoded!

// Right:
link.download = decodeURIComponent(media[1]);
```

### Issue: PDF won't open or shows corrupted
**Solution**: Check Content-Type is set correctly
```javascript
// Server should return:
response.set({ 'Content-Type': 'application/pdf' });

// Not:
response.send(buffer);  // Missing headers!
```

### Issue: Blob URL doesn't work in iframe
**Solution**: CORS and protocol constraints - use HTML5 File API
```javascript
// Wrong:
<iframe src={blobUrl} /> // May fail with CORS

// Right:
window.open(blobUrl, '_blank'); // Always works
// Or for PDFs:
<embed src={blobUrl} type="application/pdf" />
```

## Testing Media Endpoints

### Upload test (curl):
```bash
curl -X POST http://localhost:4174/api/v1/media?receiverId=ava \
  -H "Authorization: Bearer TOKEN_HERE" \
  -H "X-File-Name: test.pdf" \
  --data-binary @/path/to/test.pdf
```

### Download test (curl):
```bash
curl -X GET http://localhost:4174/api/v1/media/MEDIA_ID_HERE \
  -H "Authorization: Bearer TOKEN_HERE" \
  -o downloaded-file.pdf
```

## Performance Notes

- **Blob URL memory**: Each blob URL takes ~1-2 KB memory. Always revoke after use.
- **File size limits**: 10 MB max (configured in server). Larger files may timeout.
- **Concurrent uploads**: No limit enforced, but recommended: max 3-5 simultaneous uploads
- **Session token expiry**: No expiry configured. Sessions persist until logout.

## Future Improvements

1. Add file encryption for stored media
2. Implement thumbnail generation for images
3. Add progress indicators for large file uploads
4. Implement file sharing between groups
5. Add media deletion/expiry options
6. Implement virus scanning for uploaded files
7. Add CDN support for faster downloads
8. Implement rate limiting per user
