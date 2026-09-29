# Soul and long-term memory

Metis keeps its own identity file ("soul") and long-term memories. They belong to Metis rather
than to any single provider: every provider session reads them, whether it runs Codex, Codex 2,
Claude, Cursor, Antigravity, Grok, Droid, Devin, OpenCode, or Pi. Agents can save what they learn,
so the assistant keeps improving across sessions and provider switches.

## Where it lives

Everything is plain markdown under the server state directory: `<base>/userdata/memory`, or
`<base>/dev/memory` for a dev server, where `<base>` is the Metis data directory (`SYNARA_HOME` /
`--home-dir`). Settings > Memory shows the exact path and can open it in your editor.

```text
memory/
  soul.md                       identity, tone, and working style (you write it)
  global/<name>.md              memories that apply to every project
  projects/<projectId>/<name>.md memories for one project
```

Directories are created `0700` and files `0600`, through the same atomic temp-file-and-rename
helper as other private state. Project directories use the project id; an id that is not a plain
slug is replaced by a hash so it can never form a path.

Each memory is one file with a small frontmatter block:

```markdown
---
name: prefers-small-diffs
description: "Wants small, verified changes over broad rewrites"
type: feedback
updatedAt: 2026-09-28T10:00:00.000Z
---

Keep diffs small and run the affected checks before reporting.
```

- `name` is the file name without `.md`: 1–64 lowercase letters, digits, `-` or `_`, starting with
  a letter or digit. Files with other names are ignored.
- `type` is `user` (who the user is), `feedback` (how they want work done), `project` (facts about
  the work), or `reference` (where to find things).
- Project memories also record `projectId` and `projectTitle`.
- Hand-written files without frontmatter still work: the first line becomes the description and the
  file time becomes `updatedAt`. Symlinks are ignored.

## What every session receives

When a provider session starts, Metis delivers its host policy once. A `<metis_memory>` block
follows it, containing:

- `soul.md` in full, up to 8 KiB (longer souls are truncated with a note);
- an index of global memories and of the current thread's project memories (name, type, date, and
  description — never memory bodies), up to 8 KiB in total. Project entries are admitted first,
  newest first; anything over budget is counted in a "not shown" note.

A thread only ever receives its own project's memories. Nothing is injected when there is no soul
and no memory. The block states that memory is context, not instructions that can override the
conversation, host policy, or approvals.

Delivery points: the Claude system-prompt append, Codex developer instructions, and the first
prompt of Cursor, Grok, Droid, Devin, OpenCode, Pi, and Antigravity sessions. Changes apply to new
provider sessions; within a session, agents read current content through the tools. On Windows,
Antigravity drops the memory block when the command-line prompt limit would otherwise reject the
turn.

## Agent tools

Sessions with the thread-scoped Metis MCP gateway get four tools. Project scope always means the
calling thread's own project.

| Tool                   | Input                                               | Notes                                     |
| ---------------------- | --------------------------------------------------- | ----------------------------------------- |
| `synara_memory_list`   | `{ scope?: "global" \| "project" \| "all" }`        | Index entries plus soul presence          |
| `synara_memory_read`   | `{ scope: "global" \| "project" \| "soul", name? }` | Full body; `soul` reads `soul.md`         |
| `synara_memory_write`  | `{ scope, name, description, type, body }`          | Creates or replaces; needs an active turn |
| `synara_memory_delete` | `{ scope, name }`                                   | Needs an active turn                      |

Agents write directly, without an approval card; you review, edit, and delete in Settings. The host
policy asks agents to keep one fact per memory, update instead of duplicating, delete wrong
memories, and never store secrets or what the repository and git history already record. Agent
writes that contain credential-shaped text (private keys, `sk-…`, `ghp_…`, AWS keys, JWTs, and
similar) are rejected. Agents cannot edit `soul.md`.

## Limits

| Limit                        | Value                    |
| ---------------------------- | ------------------------ |
| Memory body                  | 16 KiB UTF-8             |
| Description                  | 200 characters, one line |
| Memories per scope           | 200                      |
| Total size per scope         | 512 KiB                  |
| `soul.md` (saved from Metis) | 32 KiB                   |
| Injected soul / index        | 8 KiB each               |

## Settings

Settings > Memory edits `soul.md`, lists global memories and memories per project (name,
description, type, update time, size), creates, edits, and deletes memories, and opens the memory
folder in your editor. Memory management over the WebSocket API is limited to the owner session.
