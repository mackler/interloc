// A fake for the two SDKs, so that the logic of src/claude.ts and src/codex.ts is tested without
// credentials. The message and turn objects carry only the fields the adapters read.

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { AgentSdk, SdkThread } from "../src/sdk.ts";

export type Call = { prompt: string; options: Options };
/** One scripted Claude Code call: the messages it produces, possibly after calling back. */
export type Script = (call: Call) => AsyncIterable<SDKMessage>;

export const init = (sessionId = "session-1"): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage;

export const success = (structured: unknown, text = "", costUsd: number | null = 0.25, turns = 3): SDKMessage =>
  ({ type: "result", subtype: "success", structured_output: structured, result: text, total_cost_usd: costUsd, num_turns: turns }) as unknown as SDKMessage;

export const failure = (subtype = "error_during_execution", costUsd: number | null = 0.1): SDKMessage =>
  ({ type: "result", subtype, total_cost_usd: costUsd, num_turns: 1 }) as unknown as SDKMessage;

export const assistantText = (text: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as SDKMessage;

export const assistantTool = (name: string, input: Record<string, unknown>): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }) as unknown as SDKMessage;

/** The messages of one call, with no callback to the adapter. */
export const messages = (...list: SDKMessage[]): Script =>
  () => (async function* () {
    for (const message of list) yield message;
  })();

export const turn = (finalResponse: string, usage: unknown = { input_tokens: 10, output_tokens: 5 }): RunResult =>
  ({ items: [], finalResponse, usage }) as unknown as RunResult;

export type ThreadCall = { input: string; turnOptions: TurnOptions | undefined };
/** An answer of `thread.run`: a turn, an error to reject with, or a function of the turn options (to observe the abort signal). */
export type TurnAnswer = RunResult | Error | ((turnOptions: TurnOptions | undefined) => Promise<RunResult>);

export class FakeSdk implements AgentSdk {
  readonly calls: Call[] = [];
  readonly threads: { options: ThreadOptions | undefined; calls: ThreadCall[] }[] = [];
  private readonly scripts: Script[];
  private readonly turns: TurnAnswer[];

  constructor(scripts: Script[] = [], turns: TurnAnswer[] = []) {
    this.scripts = [...scripts];
    this.turns = [...turns];
  }

  query(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage> {
    const call: Call = { prompt: params.prompt, options: params.options ?? {} };
    this.calls.push(call);
    const script = this.scripts.shift();
    if (script === undefined) throw new Error(`no scripted Claude Code call for: ${params.prompt.slice(0, 60)}`);
    return script(call);
  }

  startThread(options?: ThreadOptions): SdkThread {
    const record: { options: ThreadOptions | undefined; calls: ThreadCall[] } = { options, calls: [] };
    this.threads.push(record);
    const id = `thread-${this.threads.length}`;
    const answers = this.turns;
    return {
      id,
      run: async (input: string, turnOptions?: TurnOptions): Promise<RunResult> => {
        record.calls.push({ input, turnOptions });
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no scripted Codex turn");
        if (answer instanceof Error) throw answer;
        if (typeof answer === "function") return answer(turnOptions);
        return answer;
      },
    };
  }
}
