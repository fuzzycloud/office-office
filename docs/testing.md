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

`pnpm test:e2e` invokes the same Playwright suite. Its global setup builds the React UI and Rust server once. Each test starts that real server with a fresh SQLite database in a temporary directory. No test uses the development database, resets an existing office, or relies on another test running first. Setup and fixture records enter through normal RPC and engine commands; browser requests are not mocked. A test can stop and restart its own server against the same database to verify replay and session persistence.

The suite covers first-admin registration, optional starter data, team onboarding, customers, projects and boards, task comments and activity, research reports, social drafts, themes, permissions and AI key revocation. Additional scenarios cover a rejected browser session, recovery from one failed RPC, draft preservation without duplicate writes, author-versus-peer permissions, board/project isolation, mobile navigation and keyboard focus restoration. Failure simulations abort a request before delivery; they do not fabricate successful responses or claim to test an uncertain response after a committed write. HTTP tests exercise the real ConnectRPC and MCP endpoints. Test agent keys and logins belong only to disposable test offices. No AWS or social provider credentials are needed, and no test publishes posts or contacts external providers.

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
