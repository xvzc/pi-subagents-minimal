# pi-subagents-minimal

A minimal Pi extension for subagent invocation.

## Installation

This repository does not define a registry publish or install command, so no
registry installation is documented here. To use it locally, clone the
repository, install dependencies, and register the package as a Pi extension
via its declared `./src/index.ts` entry according to your Pi setup:

```sh
git clone <repo-url>
cd pi-subagents-minimal
npm install
```

## Quick start

1. Discover enabled roles: call `subagent_list` (takes no parameters).
2. Start work: call `subagent_call` with `type: "new"`, an `agent` name from
   the list, and a `prompt`. `new` and `resume` run in the background and
   return a queued acceptance promptly — do not poll with `subagent_output`.
3. Collect the result: when a completion signal names a session, call
   `subagent_output` with that `session_id`. Reads are non-consuming and may
   be repeated.
4. To continue the same session, call `subagent_call` with `type: "resume"`,
   the `session_id`, and the follow-up `prompt`. To intervene in a running
   session immediately, use `type: "steer"` with the `session_id`.
5. To wait for sessions to finish, call `subagent_wait` with `session_ids`.
   Parent input interrupts only the wait; call again to recheck state.
6. For summaries only (never full output), call `subagent_status`.

## Tools

| Tool              | Purpose                                                                                | Key parameters                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_call`   | Start (`new`), continue (`resume`), or immediately steer (`steer`) a subagent session. | `type`, `prompt`; `agent` (required for `new`); `session_id` (required for `resume`/`steer`); optional `model`, `thinking`, `workspaceDir` (`new` only). |
| `subagent_output` | Read the retained full report for one session.                                         | `session_id`.                                                                                                                                            |
| `subagent_list`   | List enabled subagent roles.                                                           | None.                                                                                                                                                    |
| `subagent_status` | Show lifecycle summaries of active and recent sessions.                                | None.                                                                                                                                                    |
| `subagent_wait`   | Wait until all named sessions are terminal.                                            | `session_ids` (non-empty, unique).                                                                                                                       |

Session IDs are 16 lowercase hex digits grouped `8-4-4`. Failures return a
coded `{ error: { code, message } }` envelope.

## Configuration

Optional JSON file named `pi-subagents-minimal.json`, loaded from two paths
with field-level precedence **defaults < global < project**:

- Global: `<agent-dir>/extensions/pi-subagents-minimal.json`
- Project: `<cwd>/.pi/pi-subagents-minimal.json`

| Field                    | Type    | Default | Bounds / values                                           |
| ------------------------ | ------- | ------- | --------------------------------------------------------- |
| `historyRetentionDays`   | integer | `7`     | `1`–`3650`                                                |
| `maxConcurrentSubagents` | integer | `8`     | `1`–`64`                                                  |
| `injectGuidelines`       | boolean | `true`  | `true` / `false`                                          |
| `defaultModel`           | string  | absent  | non-empty string                                          |
| `defaultThinking`        | string  | absent  | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

Missing files are silent; malformed files, invalid known fields, and unknown
fields are ignored with a warning and never throw. The effective config is
frozen at activation. Example:

```json
{
  "historyRetentionDays": 7,
  "maxConcurrentSubagents": 8,
  "injectGuidelines": true
}
```

## Development

Commands from `package.json`:

```sh
npm install
npm run check   # format:check + lint + typecheck + test
npm test        # vitest run
npm run build   # emits to dist/
```

## Further detail

- Internal design/specification notes: [`.specs/README.md`](.specs/README.md).

## License

MIT — see [LICENSE](LICENSE).
