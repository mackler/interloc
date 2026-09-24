// Codex through the Codex SDK. One thread per planning phase.

import type { Reviewer } from "./agents.ts";
import { CodexCallFailed } from "./errors.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import type { Config } from "./schema.ts";
import type { AgentSdk, SdkThread } from "./sdk.ts";
import type { State } from "./state.ts";

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

  async review(prompt: string): Promise<string> {
    if (this.thread === null) throw new Error("newPhase() was not called");
    try {
      const turn = await this.thread.run(prompt, { outputSchema: agentJsonSchema(S.Review) });
      this.state.recordUsage({ agent: "codex", thread_id: this.thread.id, usage: turn.usage });
      return turn.finalResponse;
    } catch (e) {
      throw new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) });
    }
  }
}
