import type { StatusService } from "../types.js";
import type { SessionStatusSource } from "./session-manager.js";

/** Public composite seam; T3 contributes only the session arrays. */
export class CompositeStatusService implements StatusService {
  constructor(private readonly sessions: SessionStatusSource) {}

  async status(): Promise<unknown> {
    return this.sessions.sessionStatus();
  }
}
