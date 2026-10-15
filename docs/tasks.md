# Tasks and discussions

Each project owns boards and tasks. Open a task card to read its description, properties and discussion. The board keeps cards compact; search and owner/priority filters help narrow the work in view. Move a task with drag and drop or its accessible column selector.

## Comments

The Comments tab belongs to the task, so its discussion follows the task when it moves between boards. Add a comment for questions, decisions, blockers or a short progress update. Put longer research in Reports and link the report to the task.

Comments record server-owned authorship and timestamps. Editing requires the current revision, so a stale editor cannot silently overwrite another change. Authors and administrators can edit or remove comments within their current project permissions. Removal is a soft deletion: the current discussion shows a tombstone and the event history is retained. This does not erase the original text from the event store or backups.

The Activity tab records task updates and comment changes separately from the conversation. Viewers can read task details and discussion; writing requires project write access. AI access uses the same permission and event pipeline, with agent provenance recorded by the server.

## Engine and transport

`ListTaskDiscussion` returns comments and task activity. `SaveTaskComment` creates or edits a comment; `DeleteTaskComment` records a soft deletion. Writes enter the typed engine, kathputli actor and transactional katha/SQLite path. Task comment counts exclude deleted comments and are derived by the server.

Comments are plain text. They do not execute instructions, fetch links, send messages, notify teammates or trigger an agent automatically. Hermes remains responsible for agent execution.
