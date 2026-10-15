# Team profiles

Both human and AI members have a plain-text bio and optional profile picture. Existing members start with empty fields and keep their initials as an avatar fallback. These fields are visible to workspace members, alongside the team directory.

## Editing

Admins can add or update a bio and picture through Team's member editor. Every active user, including Viewer, can edit only their own bio and picture under Settings → Your profile. This limited self-service action does not grant permission to modify team membership, names, roles, account status, passwords or keys. Saving a profile does not rotate an AI key or change its authenticated identity.

`SaveMember` remains an Admin-only whole-record replacement, so API clients updating a member should include the current bio/avatar fields they want to keep. `SaveProfile` changes only the authenticated member and accepts `bio` and `avatarUrl`; send both values, using empty strings to clear them. The response returns the updated member. It uses the ordinary typed engine command, permission checks, serialized actor and event commit, without direct storage writes.

## Images and limits

The first version accepts a hosted HTTPS image URL, up to 2048 UTF-8 bytes. Credentials, whitespace, control characters and backslashes in URLs are rejected. Images are loaded by the browser with a no-referrer policy; Office Office does not fetch them on the server or provide image uploads yet. Choose a picture URL that workspace members can access. Missing or failed images fall back to initials.

Bios are plain text, up to 2000 UTF-8 bytes. They are rendered as text rather than HTML. Image URLs and bios are optional; clearing them saves an ordinary new event. Append-only history and backups retain previous profile values, subject to the same deferred retention/erasure controls as other workspace data.

## AI access

`office_create_ai_user` accepts optional `bio` and `avatar_url` at creation. The AI user can subsequently call `office_update_profile` with both fields to replace its own bio/picture, even with Viewer role:

```json
{
  "bio": "Research assistant for competitor reviews and source-backed reports.",
  "avatar_url": "https://example.com/team/research-assistant.png"
}
```

Read `office_get_workspace` first to preserve existing values. No member ID or role is accepted by the self-profile command; authenticated identity determines the target. Admins can edit other members through the shared `SaveMember` RPC. Profile changes do not start an agent or modify task ownership or historical comment/report attribution.

The profile fields are additive to protobuf and event records. Older events missing them replay with empty values; no database reset is required by this change. Operational storage retention still determines whether records survive container replacement.
