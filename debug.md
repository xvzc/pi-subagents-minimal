# Abort during `subagent_wait`: investigation and possible fixes

## Symptom and scope

When an in-progress `subagent_wait` is aborted, the UI can show `Error: This operation was aborted` instead of the usual `Operation aborted`. This document records a source-level explanation and proposed fixes; it does **not** claim the specific occurrence was reproduced or that a fix was implemented. The user's earlier GitHub repository comparison was canceled and is unrelated.

Inspected runtime: `pi` 0.87.1 under `/nix/store/il4y2236i8bcrmjpqs27zbdq8f10bg3m-pi-coding-agent-0.87.1/lib/node_modules/pi-monorepo/` (called `$PI` below). The project's local development dependency under `node_modules/@earendil-works/pi-coding-agent` is 0.86.1, so its source should not be mistaken for the running host.

## Mechanism supported by source

1. `src/index.ts:811–823` registers `subagent_wait`, binds the host's tool/operation abort signal to child cancellation, and passes it to `sessions.wait`. In `src/runtime/session-manager.ts:694–725`, signal abort **resolves** the wait with `reason: "interrupted"`, rather than throwing. An ordinary parent-input event also interrupts the wait (`:1099–1104`), but is not itself the same as an operation abort and does not cancel children. Esc during an active run invokes session/agent abort; the operation signal is then aborted.
2. `$PI/node_modules/@earendil-works/pi-agent-core/src/agent-loop.ts:261–300,685–687` can continue to another assistant turn after publishing tool results. It does not generally stop before the next model request merely because the run signal is aborted. Tool-batch termination requires **every** finalized tool result to specify `terminate: true`; `subagent_wait` does not. Even a terminating batch can be followed by queued input or explicit continuation, so this flag is not a general cancellation guard.
3. The subsequent model request is wrapped in `lazyStream` (`$PI/dist/core/model-runtime.js:450–477`). Request setup includes abort-aware authentication resolution (`$PI/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js:22–32`); an already-aborted signal can reject with `signal.reason` (`pi-ai/dist/utils/abort.js:1–24`). `Agent.abort()` calls `abortController.abort()` without a reason (`pi-agent-core/dist/agent.js:216–217`). On the inspected Node runtime, that default reason is a DOMException named `AbortError` whose message is exactly `This operation was aborted`.
4. Crucially, `$PI/node_modules/@earendil-works/pi-ai/src/api/lazy.ts:5–23,46–62` unconditionally labels _any_ setup rejection `stopReason: "error"`, carrying the rejection message. `$PI/dist/modes/interactive/components/assistant-message.js:140–155` prints `Error: ${errorMessage}` for `error`, whereas it prints an unprefixed abort message for `aborted`.

Therefore an aborted tool that resolves, followed by a request attempted on the aborted run signal, provides a concrete path to the exact reported text. In contrast, provider-stream abort handlers normally use the signal to select `stopReason: "aborted"`, and `pi-agent-core`'s outer run-failure handler also checks whether its controller was aborted. Neither handles the lazy-setup path described above.

**Evidence limit:** This is a code-supported causal path, not a confirmed trace of the user's particular occurrence. No session transcript or credentials were inspected, and no end-to-end reproduction was run. An independent transport/SDK abort while the Pi signal was not aborted is another possible route to an `error` classification. Confirmation would require inspecting the affected assistant message's `stopReason`/`errorMessage` and whether its content was empty, or reproducing the event with instrumentation. The observed `subagent_wait` interruption alone does not prove which path produced the UI line.

## Fix options

### Recommended upstream correction

- **Prevent a post-abort model request in `pi-agent-core`**: after completing/publishing an aborted tool batch, end the run without selecting another assistant turn; also check the signal immediately before starting a model request, since asynchronous next-turn preparation can race with abort. Preserve the existing tool-result, `finishTurn`, `turn_end`, and `agent_end` event ordering. Do not treat message text matching as cancellation detection. This addresses the unwanted request regardless of which tool was active or whether other tool results/queued messages exist.
- **Classify aborts during lazy setup in `pi-ai`**: pass an operation signal through the relevant `lazyStream` callers, and emit an `aborted` result/event for a recognizable cancellation rejection under an aborted signal (e.g., rejection identical to `signal.reason`, or a well-defined abort error). Preserve `error` for unrelated setup/auth failures, including failures coincident with an abort. This covers legitimate cancellations occurring _inside_ setup; the agent-loop guard alone does not cover that timing.

### Local, limited mitigation

In this extension, the `subagent_wait` result could set `terminate: true` **only when its operation signal is actually aborted**, not for an ordinary `reason: "interrupted"` caused by parent input. That can prevent the immediate next model request when `subagent_wait` is the sole tool in the batch and no continuation is queued. It does not cover mixed tool batches, queued follow-up/steering, or lazy-setup aborts elsewhere. It should not be presented as a complete fix, and must preserve the current child-cancellation behavior.

## Suggested regression checks (not run)

- Abort during a sole tool and during mixed sequential/parallel tool batches: tool results and end events still appear; no additional model stream call occurs. Repeat with queued steering/follow-up and explicit continuation, plus abort during next-turn preparation.
- Unaborted tool batches and parent-input interruption retain existing continuation and child-session semantics; Esc/operation abort still cancels applicable children.
- Lazy setup with a recognized cancellation and aborted signal yields `aborted`; the same error without signal abort and an unrelated setup failure even while aborting remain `error`.
- Already-aborted waits, listener cleanup, and coded tool errors remain covered. Existing `test/subagent-wait.test.ts` covers several wait/input/abort paths, but not the host's subsequent assistant classification.

No files other than this report were changed; no test or runtime reproduction was performed as part of this analysis.
