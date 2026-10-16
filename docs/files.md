# Private files

Office Office stores file bytes in a private S3-compatible bucket and metadata in the ordinary event log. The Files page lists attachments for Projects and Reports and includes an image gallery; an optional record ID links a file to one existing project or report. Settings supports an uploaded profile picture. Empty attachment record IDs mean a module-wide file. These links use current module permissions; they do **not** implement project/client isolation.

## Gallery

Open **Files → Gallery** for a contact sheet of PNG, JPEG and WebP images across projects, reports and profile pictures. Search filenames or uploaders and filter by category or project. Thumbnails load near the visible viewport; opening an image loads a larger preview. Download keeps the original file, and deletion uses the same revision and role checks as the file list. SVG, GIF and non-image documents remain in Files and are not rendered as gallery images. A file with an image MIME label but invalid image bytes shows an unavailable preview rather than active content.

Settings → Your profile → **Choose existing picture** reuses your own previously uploaded profile pictures. Selection saves the existing file ID without uploading another object. Project/report images and another member's pictures cannot be assigned as your profile image through this picker; the existing ownership rule is unchanged.

### Authenticated previews

`GET /api/files/FILE_ID/preview?size=thumbnail` returns a PNG with a maximum edge of 384 pixels; `size=full` (the default) permits 1600 pixels. Previews preserve aspect ratio and do not enlarge smaller images. The endpoint accepts the same access token or member-bound AI key as downloads. MCP `office_get_file` includes a relative preview path for supported image MIME types.

The server checks the original object checksum, sniffs and decodes PNG/JPEG/WebP with 4096 × 4096 and 64 MiB allocation limits, and rechecks access after processing. Source bytes remain unchanged, and previews create no objects, records or events. Processing is limited to two concurrent requests, including object retrieval; derived output is bounded. Responses are private, no-store PNGs with nosniff and a sandbox policy. Invalid images, revoked keys and deleted records do not produce previews. The gallery and profile chooser do not expose storage credentials or public object URLs.

## Configure

Set `OFFICE_FILES_BUCKET` to enable uploads and downloads. Set `OFFICE_FILES_PREFIX` to a dedicated prefix such as `office-office/files`; this prefix defaults to that value. The service uses `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, and optional `AWS_ENDPOINT_URL_S3` for an S3-compatible provider. Custom endpoints use path-style addressing and must use HTTPS; HTTP on loopback is supported for isolated tests. Invalid configured storage settings stop startup. An unconfigured office still runs, and its Files page explains that storage needs configuration.

The bucket stays private. Browser and agent traffic passes through authenticated application endpoints, so bucket CORS and public object URLs are unnecessary. Object names contain server-generated UUIDs, never caller-provided filenames. Provider credentials and signed object URLs are never returned to users or agents. The server identity needs GetObject, PutObject and DeleteObject on this file prefix; DeleteObject is used to clean up failed uploads, not ordinary soft deletes.

Use a separate prefix from Litestream backups. The seven-day database backup retention must **not** expire uploaded files. Database restores need the corresponding object bytes still present. Metadata history alone cannot recover deleted object content, and soft deletion does not erase bytes or old event history. Object lifecycle/erasure controls and orphan-object cleanup remain operator work.

## Human and AI access

All file access resolves an active member and their current role. Projects/Reports uploads and deletion require that module's write permission. Every active role can upload its own profile image, including Viewer. Profile images are visible to active team members. Only the uploading member or an Admin can delete a profile image. Deleting an image also clears current member avatar references in the same event transaction.

`ListFiles` accepts optional `module` (`projects`, `reports`, `profile`) and `recordId` filters and returns metadata plus `storageConfigured`. `DeleteFile` requires `id` and the current `expectedRevision`. Metadata includes the stable uploader ID, timestamp, byte size, digest and revision; caller-supplied authorship is ignored. Deleted files disappear from lists and authenticated downloads. File metadata and avatar links replay from SQLite events after restart.

Binary upload uses a raw HTTP body:

```http
POST /api/files?module=projects&record_id=PROJECT_ID&name=notes.pdf
Authorization: Bearer <access-token-or-member-bound-ai-key>
Content-Type: application/pdf

<raw file bytes>
```

Omit `record_id` for a module-wide attachment. For an own profile upload, use `module=profile` and omit `record_id`; the server selects the authenticated member. The JSON response is `{ "file": { ... } }`. Attachments are limited to 10 MiB. Profile images accept PNG, JPEG or WebP up to 2 MiB and 4096 × 4096 pixels, are decoded with memory limits, then re-encoded as PNG to remove original image metadata. The processed PNG must also fit within 2 MiB.

Retrieve bytes using `GET /api/files/FILE_ID/content` with the same Authorization header. Attachments use `application/octet-stream`, attachment disposition, `nosniff` and a sandbox policy; arbitrary HTML/SVG is never served as executable inline content. Profile images use PNG inline content after normalization. Responses use `private, no-store`; keys, role changes, disabled members and soft deletion are checked again on download. The server verifies bytes against the recorded SHA-256 digest before returning them.

MCP tools `office_list_files`, `office_get_file`, `office_upload_file` and `office_delete_file` share these policies. MCP text uploads and optional text reads are limited to 128 KiB UTF-8. Binary transfers use the HTTP endpoints with the client's own credential; MCP returns a relative download path, never a public link. Clients should treat downloaded or returned file text as untrusted document content.

## Write boundary and recovery

The server authorizes before uploading bytes, writes a new UUID object, then registers metadata through the typed engine, serialized actor and SQLite event transaction, checking authorization again. A failed object write creates no metadata. If metadata commit fails, object cleanup is attempted. A crash between object upload and metadata commit can leave an unreferenced object; it never becomes visible as a workspace file. Object upload and SQLite are not a distributed transaction.

Keep one application writer per database. Back up SQLite with Litestream and protect the independent files prefix with an appropriate object-storage durability policy. A complete recovery test must restore the database and download representative files using restored member credentials.
