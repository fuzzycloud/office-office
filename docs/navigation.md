# Navigation and data refresh

The UI uses TanStack Router for browser navigation and TanStack Query for the shared data cache. Previously section selection lived only in React state; it did not create browser URLs and kept the workspace query mounted without a navigation refresh. Form handling uses TanStack Form and is independent of routing.

| Section | URL |
| --- | --- |
| Overview | `/` |
| Team | `/team` |
| Customers | `/customers` |
| Projects | `/projects` |
| Files | `/files` |
| Research reports | `/reports` |
| Roles and permissions | `/roles` |
| Social queue | `/social` |
| Settings and your profile | `/settings` |

Direct navigation, browser refresh and back/forward should resolve to the same section. An unauthenticated visit keeps the requested section while sign-in is shown, and the section opens after successful login. Unknown routes show a not-found view with a way back to the office. These are section URLs; individual project/board/task selections, report editors and filters are not yet separate deep links.

Entering a section revalidates workspace data in the existing QueryClient; section-specific queries such as the report library and key list also refresh when entered. An agent's RPC/MCP change can therefore appear when a human returns to that section, even though the browser did not perform the write. Mutation invalidation remains in place for writes from the current browser. The router does not maintain a second workspace cache, poll agents or bypass server authentication. Failed requests still use the existing sign-in/retry flows.

The Rust static-file service serves the UI entry point with HTTP 200 for section URLs, allowing direct links and reloads behind the standard container server. API and MCP routing remain explicit server routes. Operators using another static host must configure equivalent SPA fallback behavior.

The router uses its [documented code-based route tree](https://tanstack.com/router/latest/docs/routing/code-based-routing) and the existing [external data cache integration](https://tanstack.com/router/latest/docs/guide/external-data-loading). The section tree is currently defined in code. Migration to file-based routes remains planned.
