# Roles and permissions

Roles are fixed presets shared by humans and AI users. Open **Roles & Permissions** to inspect the server's current matrix. Permissions cannot be edited independently on a member or key. `ListRoles` is the canonical catalog; `GetWorkspace.permissions` contains the signed-in user's effective permissions. The server rechecks authorization for every operation.

| Module | Admin | Manager | Member | Viewer |
| --- | --- | --- | --- | --- |
| Team and AI keys | Read/write | Read | Read | Read |
| Customers | Read/write | Read/write | Read | Read |
| Projects, boards, tasks and comments | Read/write | Read/write | Read/write | Read |
| Research reports | Read/write | Read/write | Read/write | Read |
| Social queue | Read/write | Read/write | Read | Read |
| Settings | Read/write | Read | Read | Read |

Every active user can edit their own bio and profile picture through `SaveProfile`, including Viewers. This is limited to personal profile metadata and does not grant team administration or business-record write access. See [profiles](profiles.md).

Admin-only key listing returns credential metadata, never stored secrets. A user may edit their own comments, and Admins may moderate them, subject to projects write permission. Project-level isolation is not implemented; all four roles can read workspace records. Separate clients or customers are not security partitions.

An AI Admin can create AI users through MCP's `office_create_ai_user` or the shared RPC. Human and AI Admins have the same user/key administration authority. User kind is immutable. A caller cannot demote or disable itself, and the last active password-backed human Admin cannot be removed from recovery eligibility. Use Member for researchers who write reports/tasks, Viewer for read-only evaluation, Manager for customer/social work, and Admin only for office administration.

Creating an AI user automatically creates its own 90-day key. The creation response shows the secret once. Keys are login credentials, not another permission layer: changing the user's role applies immediately to its keys and existing sessions. Rotation revokes all previous keys and sessions for that member and returns a new secret once. Disabling an AI user denies access even with a valid key. Provision separate users for separate AI identities so authorship and revocation remain accountable.

## Upgrade policy

This replaces v0.3.0's separate member access lists and key scopes. Those legacy fields remain in protobuf/events for compatibility but are ignored for authorization. Existing member-bound keys remain usable under the member's current role. This can broaden access compared with an old narrow key; review all role assignments before upgrading. Legacy v0.2 creator-bound keys are still rejected and must be replaced. No history is rewritten and no database reset is required.
