/**
 * Safe diagnostics adapter (010 T1).
 *
 * User-visible warnings are delivered through the host `ExtensionUIContext`
 * so they never bypass TUI rendering or corrupt the interactive terminal.
 * Delivery is best-effort: a missing UI, a UI without `notify`, or a
 * synchronous notification failure silently drops the warning. There is
 * deliberately no console or stdio fallback (D3).
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Deliver one warning notification through the host UI, or drop it. */
export function notifyWarning(
  ui: ExtensionUIContext | undefined,
  message: string,
): void {
  if (!ui || typeof ui.notify !== "function") return;
  try {
    ui.notify(message, "warning");
  } catch {
    // Notification failures must never reach the terminal or the caller.
  }
}
