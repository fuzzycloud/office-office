# Changelog

## 0.2.1

- Fix accessible labels for populated task descriptions and research editor textareas.
- Contain off-screen task labels and simplify the narrow navbar so mobile pages fit the viewport.
- Initiate native drag before scrolling in browser automation; disambiguate research headings and avoid the navigation/response-body race during authentication recovery.
- Verify all 19 E2E scenarios successfully against real servers and Chromium.

## 0.2.0

- Persist workspace events and private authentication state in SQLite, with atomic command commits, restart replay and a single writer lock. Include an optional Litestream configuration template.
- Create optional sample offices through typed engine commands during first-admin registration, using fictional customers, projects, tasks, research and disconnected social drafts.
- Add research reports with sources, recurring editions, revision checks and scoped MCP access.
- Add task details, comments, activity history, comment counts and event-based comment soft deletion. Record human and AI-key authorship separately.
- Improve project boards with search, owner/priority filters and drag-and-drop, retaining an accessible column selector.
- Fix select-field accessible names used during team onboarding and task editing, and close the mobile drawer when a page is selected.
- Add isolated browser and HTTP scenarios against real Rust servers and disposable SQLite databases, including permission failures, concurrent edits, restart persistence, agent comments and recovery workflows. CI retains reports and failure artifacts.

The GHCR image remains a preview. Live social posting, general record deletion, analytics ingestion and verified backup restoration remain deferred.
