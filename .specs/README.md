# Specifications

This repository uses feature-centric spec-driven development.

## Feature Map

```text
.specs/
├── constitution.md
├── 000-foundation/
├── 001-agent-registry/
├── 002-subagent-runtime/
├── 003-record-storage/
├── 004-async-concurrency/
├── 005-subagent-call-rendering/
├── 006-coordination-prompt/
├── 008-subagent-wait/
├── 009-session-id-format/
├── 010-context-diagnostics/
├── 011-isolated-workspace/
└── 012-guideline-injection/
```

| Feature | Responsibility |
|---|---|
| `000-foundation` | Package scaffold, shared contracts, errors, and configuration |
| `001-agent-registry` | Strict agent metadata, discovery, precedence, and listing |
| `002-subagent-runtime` | Background new/resume, immediate steer, output, and session status |
| `003-record-storage` | Atomic file records, restart-safe inspection, and retention cleanup |
| `004-async-concurrency` | Background FIFO concurrency gate, Agents TUI, and hidden completion signal delivery |
| `005-subagent-call-rendering` | Background call rows, steer control rendering, and `subagent_output` Agent Output presentation |
| `006-coordination-prompt` | Coordination policy delivered via detailed tool `description` strings |
| `008-subagent-wait` | Interruptible all-session wait with snapshot-based re-wait |
| `009-session-id-format` | Prefixless random 64-bit `8-4-4` session identifiers |
| `010-context-diagnostics` | Context-based warning delivery without raw terminal output |
| `011-isolated-workspace` | Optional isolated child execution directory for new sessions |
| `012-guideline-injection` | Config-gated parent system-prompt injection of embedded coordination guidance |

Contract note: `subagent_call` with `type: "new"` or `"resume"` always
executes in background and returns a queued acceptance promptly; there is no
`async` parameter and no foreground execution. `steer` is an immediate
control operation on a running session. Terminal completion arrives as a
hidden follow-up signal naming the session and status with a
`subagent_output` fetch instruction; the authoritative full result is
observed via `subagent_output`, which renders it as Agent Output in its tool
result region. No foreground Agent Output entry exists.

## Dependency Order

```text
000-foundation
  ├─→ 001-agent-registry
  ├─→ 003-record-storage
  └─→ 002-subagent-runtime ←─ 001-agent-registry
          ↑                      ↑
          └──── 003-record-storage
          ├─→ 004-async-concurrency ←─ 002-subagent-runtime
          ├─→ 005-subagent-call-rendering ←─ 002-subagent-runtime
          ├─→ 006-coordination-prompt ←─ 002-subagent-runtime + 004-async-concurrency
          ├─→ 008-subagent-wait ←─ 002-subagent-runtime + 004-async-concurrency
          ├─→ 009-session-id-format ←─ 000-foundation + 002-subagent-runtime + 003-record-storage
          ├─→ 010-context-diagnostics ←─ 000-foundation + 002-subagent-runtime + 003-record-storage + 004-async-concurrency
          ├─→ 011-isolated-workspace ←─ 000-foundation + 002-subagent-runtime
          └─→ 012-guideline-injection ←─ 000-foundation + 006-coordination-prompt
```

`002-subagent-runtime` defines session behavior and consumes the record-store boundary implemented by `003-record-storage`.

Recommended implementation order:

```text
000-foundation → 001-agent-registry → 003-record-storage → 002-subagent-runtime → 004-async-concurrency → 005-subagent-call-rendering → 006-coordination-prompt → 008-subagent-wait → 009-session-id-format → 010-context-diagnostics → 011-isolated-workspace → 012-guideline-injection
```

Each feature contains:

- `requirements.md` — intent, constraints, and non-goals
- `spec.md` — observable behavior and acceptance criteria
- `design.md` — implementation architecture and decisions
- `tasks.md` — executable plan and progress
- `verification.md` — acceptance evidence

Authority order:

```text
constitution → requirements → specification → design → tasks → implementation → verification
```
