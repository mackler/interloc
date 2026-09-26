// The two SDKs as the adapters use them. A test supplies a fake, so the logic of src/claude.ts and
// src/codex.ts is covered without credentials. `liveSdk` binds the real SDKs and is the only
// untested code of the pair (plan U1).

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";

/** One Codex thread. `Thread` of the Codex SDK satisfies this. */
export type SdkThread = {
  readonly id: string | null;
  /** One turn, streamed (the activity line shows its tool use); `RunStreamedResult` of the Codex SDK is `{ events }`. */
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

export type AgentSdk = {
  /** One Claude Code call. The messages of the turn arrive in order. */
  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
  startThread(options?: ThreadOptions): SdkThread;
};
