// Codex through the Codex SDK. One thread per planning phase.

import type { Reviewer } from "./agents.ts";
import type { AgentSdk, SdkThread } from "./sdk.ts";
import { reviewSchema } from "./schemas.ts";
import { CodexCallFailed } from "./errors.ts";
import type { State } from "./state.ts";
import type { Config, Review } from "./types.ts";

export class CodexReviewer implements Reviewer {
  private readonly state: State;
  private readonly config: Config;
  private readonly sdk: AgentSdk;
  private thread: SdkThread | null = null;

  constructor(state: State, config: Config, sdk: AgentSdk) {
    this.state = state;
    this.config = config;
    this.sdk = sdk;
  }

  // Bubblewrap cannot start in the container, so Codex's own sandbox is off. The container and its
  // firewall are the boundary, and the caller compares the project state after every turn.
  newPhase(): void {
    this.thread = this.sdk.startThread({
      workingDirectory: this.state.project,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      ...(this.config.codexModel !== null ? { model: this.config.codexModel } : {}),
    });
  }

  async review(prompt: string): Promise<Review> {
    if (this.thread === null) throw new Error("newPhase() was not called");
    let text: string;
    try {
      const turn = await this.thread.run(prompt, { outputSchema: reviewSchema });
      this.state.recordUsage({ agent: "codex", thread_id: this.thread.id, usage: turn.usage });
      text = turn.finalResponse;
    } catch (e) {
      throw new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) });
    }
    const parsed = JSON.parse(text) as Review;
    if (!Array.isArray(parsed.issues)) throw new CodexCallFailed({ message: "the Codex response contains no issues array" });
    return parsed;
  }
}
