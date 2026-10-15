# Research reports

Reports are shared, durable pages for research findings. Humans and agents use the same actor command and SQLite event journal. They can hold competitor reviews, market research, customer research or other recurring investigations. This slice does not ingest email campaign metrics or produce analytical dashboards.

## Write and read

Open **Reports** and choose **New report**. Add a title, short summary, report content, topic and optional reporting period. Choose Research or Competitor review and draft or published status. A report can link to a project and one of its tasks. Add named HTTP/HTTPS source citations so readers can inspect the evidence.

The reader shows findings, sources, author, last editor and revision. Markdown headings, paragraphs and lists have a safe reading view; embedded HTML is never executed. Source links open outside Office Office and are not fetched or verified by the server. A citation records what the author supplied; it does not prove a claim or a successful external connection.

Search the report library, filter status or project, and page through report summaries. Full report bodies are fetched only when opened. Use **New edition** to create another report under the same topic for a new period; it leaves the previous edition intact. Editing a report instead updates that page and appends another saved-record event. There is no revision-history browser yet.

Draft and published are editorial states, not approval records or separate privacy boundaries. Users with report read access can read both. Viewer roles cannot write; members and managers need the reports module, and admins have full access. Existing non-admin accounts must be granted this new module explicitly.

## Give an agent access

Create a named AI key in Settings with `reports:write` for writing and reading, or `reports:read` for reading only. Add `projects:read` if the agent also needs to discover project and task IDs for links. Do not give it account-administration permissions. The owner's current permissions still apply to every call.

The MCP endpoint remains `/mcp`. Report tools are:

| Tool | Use |
| --- | --- |
| `office_list_reports` | Search summaries with `query`, `status`, `project_id`, `page_size` and `offset` |
| `office_get_report` | Read a report and its current revision by `id` |
| `office_save_report` | Create a report or save a revision-aware replacement |

Example arguments for `office_save_report` (replace the illustrative findings and source with the agent's actual research):

```json
{
  "title": "Competitor review — week 42",
  "kind": "competitor_review",
  "topic": "Competitor reviews",
  "period": "2026-W42",
  "status": "draft",
  "summary": "State the main findings from this investigation.",
  "body": "# Findings\nDescribe the evidence and distinguish observations from inference.\n\n# Next steps\n- Recommend a concrete follow-up.",
  "sources": [
    {"title": "Illustrative source — replace before use", "url": "https://example.test/research"}
  ],
  "expected_revision": 0
}
```

Creation uses a blank or omitted ID and expected revision zero. To edit, first call `office_get_report`, preserve fields you want to keep, and supply its ID and current revision as `expected_revision`. Stale saves return a conflict; read again and reconcile changes. The server owns authorship, timestamps and revision numbers. Raw agent key secrets never appear in report events.

Creation is not idempotent. If a result is uncertain, list and inspect the topic and reporting period before retrying, rather than blindly creating a duplicate. The body limit is 200,000 UTF-8 bytes, with up to 30 source citations. List pages default to 20 and are capped at 100 entries. Use `nextOffset` for the next page; zero means there is no next page. Drafts may have an empty body, while publishing requires findings.

Hermes owns recurring schedules and research execution. For a weekly task, configure Hermes to research, inspect existing editions, and write a new report with the appropriate topic and period. Office Office stores and displays its output; it does not run the research, verify sources or schedule agents.

## Future analytical reports

Email marketing and other analytical reporting need real connector data, metric definitions, time ranges and provenance. Those adapters and dashboards are deferred. No sample campaign numbers or inferred performance are presented as actual business results.
