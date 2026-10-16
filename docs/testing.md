# Automated testing

## Browser and HTTP tests

Install the project dependencies and Chromium once:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
```

Run the suite from the repository root:

```sh
just test-e2e
```

`pnpm test:e2e` invokes the same Playwright suite. Its global setup builds the React UI and Rust server once. Each test starts that real server with a fresh SQLite database in a temporary directory. No test uses the development database, resets an existing office, or relies on another test running first. Setup and fixture records enter through normal RPC and engine commands; most browser scenarios use real RPCs throughout. File UI contract tests explicitly intercept file metadata/byte transfers without claiming to verify S3; bootstrap, sessions and role setup still use the real server. A test can stop and restart its own server against the same database to verify replay and session persistence.

The suite covers first-admin registration, optional starter data, team onboarding, customers, projects and boards, task comments and activity, research reports, social drafts, themes, permissions and AI key revocation. Additional scenarios cover a rejected browser session, recovery from one failed RPC, draft preservation without duplicate writes, author-versus-peer permissions, board/project isolation, mobile navigation and keyboard focus restoration. Failure simulations abort a request before delivery; they do not fabricate successful responses or claim to test an uncertain response after a committed write. HTTP tests exercise the real ConnectRPC and MCP endpoints. Test agent keys and logins belong only to disposable test offices. No AWS or social provider credentials are needed for the automated suite, and no test publishes posts or contacts external providers.

Run a focused file or inspect a failure:

```sh
pnpm test:e2e tests/e2e/boards.spec.ts
pnpm test:e2e --headed
pnpm exec playwright show-report
pnpm exec playwright show-trace test-results/<failed-test>/trace.zip
```

The runner retains failure traces and screenshots and writes an HTML report. GitHub Actions installs Chromium, runs the suite and uploads the reports and test artifacts. Artifacts can contain disposable test-office records and generated test credentials; keep their retention short. Test failures are not retried automatically to hide flaky behavior.

The machine running the suite must allow local TCP sockets and Chromium processes. A restricted coding sandbox can typecheck and build the app while still rejecting server startup or browser launch. Such a failure is an execution failure, not a skipped test or a passing browser run.

## Engine and storage tests

```sh
cargo test --locked -p office-server
cargo clippy --locked -p office-server --all-targets -- -D warnings
```

These tests exercise typed commands, permissions, revisions, event replay, transactional rollback, storage validation and MCP/RPC adapters without requiring a listening HTTP port. Use them alongside the browser suite: they can pinpoint an engine failure, while the browser suite verifies that a person can complete the workflow through the UI.

## Coverage boundaries

Passing scenario counts do not measure statement or branch coverage. The browser suite currently targets Chromium, including a 390px layout; this is not evidence of Safari, Firefox or physical-device compatibility. Invalid-session recovery is covered through the browser, while genuine JWT expiry is checked by the Rust suite. Large datasets, response-loss after commit, backup restore and external publishing are not covered by these scenarios. A full CI run must pass before treating browser behavior as verified.

Board/project consistency tests reject invalid references; they do not prove member-specific project authorization. Current key tests cover distinct AI members, token exchange, live member/key state, fixed-role permissions, revocation and stable attribution. Project membership remains unimplemented. The [next-deployment acceptance matrix](agent-team-access.md#next-deployment-acceptance-matrix) specifies the additional identity, isolation, assignment, concurrency and retry tests required as those features are implemented. It is a test plan, not additional passing coverage.

The [dispatch acceptance cases](agent-dispatch.md#acceptance-tests-before-calling-dispatch-functional) additionally require explicit Ready triggers, competing claims, duplicate delivery, real start acknowledgment, heartbeat loss, uncertain starts, cancellation/reassignment, stale completion, cursor recovery and authorized review. Automatic dispatch is optional, not implemented, and not covered by today's passing suite.

## Verified run — 2026-10-15

The complete Chromium suite passed all 19 scenarios against isolated real servers after host networking and browser execution were enabled. This includes mobile width and keyboard checks, native drag-and-drop, report editing, concurrency, session recovery and SQLite restart persistence. Runtime failures exposed populated-textarea label associations and mobile accessibility-label overflow; both were fixed rather than bypassed. The drag test now initiates a native drag before scrolling to its destination. The invalid-session test checks the HTTP status before the app's intentional navigation, avoiding a race reading an old response body.

## Shared human/AI authentication verification — 2026-10-16

The prior v0.3.0 implementation passed all 30 Rust tests and all 20 real-server Chromium scenarios (33.1 seconds for the final browser run). Coverage includes admin-created AI profiles without email/password, member-bound key issuance, raw-key rejection at MCP, token exchange, RPC/MCP scope enforcement, token invalidation after revocation/deactivation, stable authorship across two AI users and key rotation, and SQLite replay. Human viewer metadata and last-human-admin protection have regression tests. Clippy, frontend and browser-source TypeScript checks, browser-source Biome checks, schema generation and the frontend production build passed. This does not claim project isolation, OAuth discovery, live client compatibility, backup restoration or automatic execution.

## Fixed roles and AI provisioning verification — 2026-10-16

The fixed-role implementation passed all 32 Rust tests and Clippy with warnings denied. All 21 real-server Chromium scenarios were verified: 20 passed in the full run, and onboarding passed on its focused rerun after narrowing ambiguous selectors. Frontend and browser-source TypeScript checks, Biome, schema generation and the production UI build passed. Coverage includes the complete role matrix and write enforcement, automatic one-time AI keys, direct-key MCP access, AI Admin provisioning, atomic rotation invalidating old keys/tokens, live role changes, AI Admin comment moderation and a Viewer reading the roles page. The browser suite caught and fixed a key dialog that originally rendered only in Settings instead of immediately after Team creation. These are local checks; live client evaluation and deployment remain separate.

## Profiles and URL navigation checkpoint — 2026-10-16

The profile backend passed 35 Rust tests and Clippy with warnings denied. All 27 browser scenarios were verified: 26 passed in the full run, and the mobile suite passed on a focused rerun after replacing its old reload-to-Overview expectation with preservation of `/settings`. Frontend and new browser-source TypeScript checks, browser-source Biome, schema generation and the UI production build passed. Coverage includes human/AI self-profile permissions, image failure/recovery, validation, SQLite replay, direct section URLs, reload HTTP 200, back/forward, deep-link login and route-entry refresh after separate AI writes to customers and reports.

This checkpoint is committed for continued development; it has not been released or deployed. The hosted test office remains v0.4.0. Section routes are implemented; individual task/board/report deep links and image uploads remain outside this slice.

## Optional Litestream runtime verification — 2026-10-16

`just test-runtime` runs ShellCheck and 11 Bats cases for the Docker entrypoint, without AWS or a running application. CI runs the same checks. Cases cover disabled mode, configuration validation, existing databases, missing-database restore, explicit new-office initialization, restore failures, empty restore output, stale SQLite sidecars, no-clobber promotion and command forwarding. ShellCheck 0.11.0 and Bats 1.14.0 passed locally.

The `runtime-base` Docker target built successfully and executed pinned Litestream 0.5.17 as the non-root application user. A separate real local Docker drill used the built debug server and disposable data/replica volumes: after an initial replica existed, a later write was committed, the supervisor was gracefully stopped, and a fresh container restored the database. Customer records, password login, the original JWT signing state and AI-key authentication survived; `PRAGMA integrity_check` returned `ok`. This verifies the real Litestream file backend and app replay, not AWS credentials, bucket policy or live S3 recovery. The hosted office was not touched.

## Private files and S3 verification — 2026-10-16

File engine tests cover role and owner checks, image validation/normalization, metadata replay, revision-checked soft deletion with retained object bytes, failed object writes, digest corruption and raw AI-key HTTP authentication/revocation. MCP tests exercise text upload/read and stale-delete rejection. Browser file tests use explicit test-only file transport responses to verify upload/download controls, downloaded bytes, profile pictures, Viewer behavior, route refresh and unconfigured storage; they do not prove live object-store behavior.

Separate isolated checks against an S3-compatible bucket verified object upload/download and cleanup, plus real bundled Litestream replication and a fresh Docker-volume restore with SQLite integrity/content checks using the seven-day configuration. Temporary replicas and objects were removed. These checks did not touch the hosted office. A complete hosted-office migration and combined database-plus-attachment recovery remain deployment checks.

The completed file-storage change passed 40 Rust tests (six existing ignored cases),
Clippy with warnings denied, schema regeneration, frontend TypeScript/build,
container startup checks and browser-source Biome. The full browser run passed
29 of 30 scenarios; the new Files scenario found duplicate page headings. After
fixing the heading, all three file scenarios passed on a focused rerun. The real
S3 application drill additionally verified HTTP/MCP upload and text read,
anonymous-access denial, Viewer restrictions, normalized avatars, SQLite restart
replay, soft deletion and key revocation against a disposable local office. Only
its temporary object prefix was cleaned up; the hosted office was untouched.


## Whole-code review checkpoint — 2026-10-16

Reviewed backend commands, authentication/RPC/MCP policy, actor rollback and SQLite
replay, file storage, frontend state/navigation, Docker/release configuration and
documentation. Concrete fixes bind delayed results and one-time key reveals to
their initiating browser session, preserve queued-post instants when editing in
non-UTC browsers (including repeated DST hours), and prevent board drafts from
switching projects through status-filter fallbacks. Private operator files are
explicitly excluded from Docker build contexts, and obsolete setup docs were
corrected.

`just check` passed: 40 Rust tests, six generated ignored doc examples, Clippy,
formatting, TypeScript/build and 11 container startup cases. All 35 Chromium
scenarios passed together. New scenarios cover delayed real key-rotation results
across sign-out/login, a delayed real unauthorized response after a new login,
board-draft project binding, and Kolkata/New York scheduling. Browser-source
Biome and both RustSec/pnpm dependency audits passed. The updated S3 client also
passed the isolated real-bucket HTTP/MCP file/identity/replay drill described above.

These checks support incremental work on the current single-office design; they
are not a claim of statement/branch coverage or production hardening. File-based
routing, project-specific access grants, task/board optimistic concurrency,
command idempotency and hosted recovery/monitoring remain planned. Full projection
snapshots and credential-table rewrites on each command are potential growth
costs; measure them with larger offices before changing the transactional model.
No release, deployment or hosted data migration was performed during this review.


## Gallery checkpoint — 2026-10-16

Files now includes a searchable image gallery with category/project filters,
lazy private thumbnails, full previews, original downloads and revision-checked
soft deletion. Settings can reuse an existing profile upload belonging to the
current member without uploading another object.

`just check` passed: 43 Rust tests, six generated ignored doc examples, Clippy,
formatting, TypeScript/build and 11 container startup cases. All 38 Chromium
scenarios passed together. The three new browser scenarios cover filtering,
image-type exclusions, lazy loading, retry, download bytes, confirmation before
deletion, Escape/focus restoration, Viewer restrictions, own-profile reuse and a
390px overflow check. Desktop/mobile screenshots were inspected. File transport
responses in these browser scenarios are explicit fixtures, not real S3 calls.
Gallery components and tests pass Biome; existing App/API lint findings remain
outside this change.

Rust tests verify bounded dimensions, safe image decoding, private response
headers, invalid/revoked-key denial, deletion denial and absence of preview-side
writes. A separate disposable local office verified authenticated previews and
spoof rejection against the actual private S3-compatible store, alongside the
existing upload/replay/role/deletion checks. Its temporary objects were removed.
No stored thumbnail objects, schema migration, release or deployment are needed
for source integration; the hosted office was not changed.


## Gallery-to-profile UI fix — 2026-10-16

The profile picker now lists all readable raster images. Own profile images reuse
their IDs; other gallery images are fetched as a private bounded PNG thumbnail,
uploaded to the authenticated member's profile, then selected. Originals stay
unchanged and the server's own-profile validation remains in force. No backend,
protobuf or database migration changed. Shared decorative action icons preserve
accessible button names and existing delete confirmations.

Frontend TypeScript/build passed, as did Biome for the picker/gallery/icon
components and browser tests. The full isolated Chromium run passed all 43
scenarios, including eight gallery cases. New explicit file-transport fixtures
cover project/report/other-member profile selection, authenticated thumbnail and
PNG upload, use of the new owned ID, no source deletion and preview/upload failure
recovery. Own-profile reuse still performs no upload. Desktop and 390px picker
screenshots were inspected; the picker uses two columns to keep action labels
readable in the Settings panel. These fixture tests do not constitute another
live S3 drill. No release or deployment was performed for this fix.
