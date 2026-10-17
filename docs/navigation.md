# Navigation and data refresh

The UI uses TanStack Router for browser navigation and TanStack Query for the shared data cache. Previously section selection lived only in React state; it did not create browser URLs and kept the workspace query mounted without a navigation refresh. Form handling uses TanStack Form and is independent of routing.

| Section | URL |
| --- | --- |
| Overview | `/` |
| Team | `/team` |
| Notifications and activity | `/notifications` |
| Customers | `/customers` |
| Projects | `/projects` |
| Files | `/files` |
| Research reports | `/reports` |
| Roles and permissions | `/roles` |
| Social queue | `/social` |
| Settings and your profile | `/settings` |

Direct navigation, browser refresh and back/forward should resolve to the same section. An unauthenticated visit keeps the requested section while sign-in is shown, and the section opens after successful login. Unknown routes show a not-found view with a way back to the office. Source links use section URLs with bounded `sourceKind`, `sourceId` and optional exact `revision` search parameters. Task, project discussion and report links restore the relevant detail when the member has access; authorization still happens at the server.

Entering a section revalidates workspace data in the existing QueryClient; section-specific queries such as the report library and key list also refresh when entered. An agent's RPC/MCP change can therefore appear when a human returns to that section, even though the browser did not perform the write. Mutation invalidation remains in place for writes from the current browser. The router does not maintain a second workspace cache, poll agents or bypass server authentication. Failed requests still use the existing sign-in/retry flows.

The Rust static-file service serves the UI entry point with HTTP 200 for section URLs, allowing direct links and reloads behind the standard container server. API and MCP routing remain explicit server routes. Operators using another static host must configure equivalent SPA fallback behavior.

The router uses [TanStack file-based routes](https://tanstack.com/router/latest/docs/routing/file-based-routing) in `apps/web/src/routes`. The Vite router plugin runs before React and generates `routeTree.gen.ts`; do not edit that file. Shared cache revalidation lives in `route-context.ts`. Keep generated route changes with their source route changes so a fresh typecheck works before Vite runs.
