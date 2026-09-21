// Codex through the Codex SDK. One thread per planning phase.

import { Codex } from "@openai/codex-sdk";
import type { Thread } from "@openai/codex-sdk";
import type { Reviewer } from "./agents.ts";
import { reviewSchema } from "./schemas.ts";
import { Halt, type State } from "./state.ts";
import type { Config, Review } from "./types.ts";

export class CodexReviewer implements Reviewer {
  private readonly codex = new Codex();
  private readonly state: State;
  private readonly config: Config;
  private thread: Thread | null = null;

  constructor(state: State, config: Config) {
    this.state = state;
    this.config = config;
  }

  // Bubblewrap cannot start in the container, so Codex's own sandbox is off. The container and its
  // firewall are the boundary, and the caller compares the project state after every turn.
  newPhase(): void {
    this.thread = this.codex.startThread({
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
      text = (await this.thread.run(prompt, { outputSchema: reviewSchema })).finalResponse;
    } catch (e) {
      throw new Halt(`Codex review failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = JSON.parse(text) as Review;
    if (!Array.isArray(parsed.issues)) throw new Halt("the Codex response contains no issues array");
    return parsed;
  }
}
