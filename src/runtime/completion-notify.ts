import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalRunStatus } from "../types.js";

export const ASYNC_PUSH_WARNING =
  "[pi-subagents-minimal] Could not deliver an asynchronous subagent completion.";
export const COMPLETION_MESSAGE_TYPE = "pi-subagents-minimal:completion";

export interface CompletionSignal {
  sessionId: string;
  status: TerminalRunStatus;
}

export interface AsyncCompletionNotifier {
  notify(signal: CompletionSignal): void | Promise<void>;
}

/** Build the host-edge adapter. The hidden signal stays in model context and prompts a `subagent_output` fetch. */
export function createHostNotifier(
  pi: Pick<ExtensionAPI, "sendMessage">,
): AsyncCompletionNotifier {
  return {
    notify(signal): void {
      pi.sendMessage(
        {
          customType: COMPLETION_MESSAGE_TYPE,
          content:
            `Subagent ${signal.sessionId} settled with status ${signal.status}. ` +
            `Call subagent_output with {"session_id": "${signal.sessionId}"} to read the full result.`,
          display: false,
          details: {
            session_id: signal.sessionId,
            status: signal.status,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  };
}
