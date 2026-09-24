// The real SDKs behind the AgentSdk interface. This file is the only untested code of the pair
// (plan U1): no test may reach the real agents, so nothing here is covered.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import type { AgentSdk } from "./sdk.ts";

const codex = new Codex();

export const liveSdk: AgentSdk = { query, startThread: (options) => codex.startThread(options) };
