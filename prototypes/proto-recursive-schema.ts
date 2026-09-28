// Does a recursive Effect Schema survive the JSON Schema generation, and do both agents accept the
// result and answer it? The decision-support representation of docs/decision-making.md nests
// counterarguments and defenses without limit, so its schema is recursive, unlike the seven schemas
// that prototypes/proto-schema.ts proved.
//
// Usage: node prototypes/proto-recursive-schema.ts            generation only, no credentials
//        node prototypes/proto-recursive-schema.ts /path/to/project [output dir]   also the agents
//        --only=<agent>[:<schema>]                            one case, for reproducing a failure
//
// Only the raw variant is sent. The strict transform of src/jsonSchema.ts inlines every $ref and so
// rejects a cycle by construction; that is reported, not worked around.
//
// Result, 28 Sep 2026, in the development container (Opus 5.5 and gpt-6-astra):
//   - Generation works. Schema.suspend yields a $ref/$defs cycle with additionalProperties: false
//     and a complete required list, the shape the program already sends.
//   - Codex accepted all three schemas and its replies decoded, nested three deep.
//   - The Agent SDK accepted `entry` and `representation` and its replies decoded, nested three
//     deep, but rejected `argument` twice with "API Error:" after three seconds. The difference is
//     not the recursion, which all three share: `argument`'s root is a bare {"$ref": ...}, while the
//     other two have a concrete object at the root. So a recursive schema is safe as long as its
//     root is an object -- which the representation's is.
//   - The strict transform rejects all three as cyclic_ref, by construction. For this schema there
//     is therefore no fallback if Effect's generation ever changes.

import { Exit, Result, Schema } from "effect";
import { rawJsonSchema, strictJsonSchema } from "../src/jsonSchema.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One argument against an element, with the replies to it, and the replies to those, without limit. */
type Argument = { readonly says: string; readonly replies: readonly Argument[] };
const Argument: Schema.Codec<Argument> = Schema.Struct({
  says: Schema.String,
  replies: Schema.Array(Schema.suspend((): Schema.Codec<Argument> => Argument)),
});

/** One element of an entry: its prose, and the counterarguments that dispute it (the revised document). */
const Element = Schema.Struct({ prose: Schema.String, counterarguments: Schema.Array(Argument) });

/** An advantage or a disadvantage: a title and the seven elements, each with its own counterarguments. */
const Entry = Schema.Struct({
  title: Schema.String,
  comparative_condition: Element,
  starting_cause: Element,
  intermediate_steps: Element,
  threshold: Element,
  effect_on_persons: Element,
  reason_the_effect_matters: Element,
  extent_of_the_effect: Element,
});

const Representation = Schema.Struct({
  columns: Schema.Array(Schema.Struct({ option: Schema.String, advantages: Schema.Array(Entry), disadvantages: Schema.Array(Entry) })),
  recommendation: Schema.String,
});

const schemas: Record<string, Schema.Top> = { argument: Argument, entry: Entry, representation: Representation };

// ---- stage 1: generation, local ------------------------------------------------------------------

const say = (line: string): void => void process.stdout.write(line + "\n");
for (const [name, s] of Object.entries(schemas)) {
  const raw = rawJsonSchema(s);
  const text = JSON.stringify(raw);
  const strict = strictJsonSchema(raw);
  say(`generate ${name}: ${text.length} bytes, ${Object.keys((raw.$defs ?? {}) as object).length} $defs, ${(text.match(/"\$ref"/g) ?? []).length} $ref`);
  say(`  strict transform: ${Result.isSuccess(strict) ? "accepted" : `rejected (${JSON.stringify(strict.failure)})`}`);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const projectArg = positional[0];
if (!projectArg) {
  say("\nNo project directory given: generation only. Pass one to send the raw variant to both agents.");
  process.exit(0);
}

// ---- stage 2: the two agents ---------------------------------------------------------------------

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { Codex } = await import("@openai/codex-sdk");

const projectDir = path.resolve(projectArg);
const outDir = path.resolve(positional[1] ?? path.join(os.tmpdir(), "proto-recursive-output"));
fs.mkdirSync(outDir, { recursive: true });

// --only=<agent>:<schema>, each part optional, for reproducing one case (as proto-schema.ts has).
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(":");
const selected = (agent: string, name: string): boolean => [agent, name].every((part, i) => !only[i] || only[i] === part);
const TIMEOUT_MS = 180_000;
const prompt = (name: string): string =>
  `This is a test of structured output. Do not read or change any file. Return a minimal valid instance of the required output schema (${name}). Nest at least two levels of replies in one counterargument, so that the recursion is exercised; use empty arrays elsewhere.`;
const decodes = (s: Schema.Top, value: unknown): boolean => Exit.isSuccess(Schema.decodeUnknownExit(s as never, { onExcessProperty: "error" })(value));
const depth = (value: unknown): number => {
  const of = (node: unknown): number =>
    node !== null && typeof node === "object" && Array.isArray((node as { replies?: unknown }).replies)
      ? 1 + Math.max(0, ...((node as { replies: unknown[] }).replies.map(of)))
      : 0;
  const walk = (node: unknown): number => {
    if (Array.isArray(node)) return Math.max(0, ...node.map(walk));
    if (node === null || typeof node !== "object") return 0;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.counterarguments)) return Math.max(...n.counterarguments.map(of), ...Object.values(n).map(walk));
    if (Array.isArray(n.replies)) return of(n);
    return Math.max(0, ...Object.values(n).map(walk));
  };
  return walk(value);
};
const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);

const codex = new Codex();
const thread = codex.startThread({ workingDirectory: projectDir, sandboxMode: "danger-full-access", approvalPolicy: "never" });

for (const [name, s] of Object.entries(schemas)) {
  const json = rawJsonSchema(s);
  fs.writeFileSync(path.join(outDir, `${name}.raw.json`), JSON.stringify(json, null, 2) + "\n");

  if (selected("codex", name)) {
    say(`\n-> codex  ${name} ...`);
    const t0 = Date.now();
    try {
      const turn = await thread.run(prompt(name), { outputSchema: json, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const value = JSON.parse(turn.finalResponse);
      fs.writeFileSync(path.join(outDir, `${name}.codex.json`), JSON.stringify(value, null, 2) + "\n");
      say(`codex  ${name}: accepted, ${decodes(s, value) ? "decodes" : "DOES NOT DECODE"}, nesting depth ${depth(value)} (${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (e) {
      say(`codex  ${name}: REJECTED: ${oneLine(e)} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }

  if (!selected("claude", name)) continue;
  say(`-> claude ${name} ...`);
  const t1 = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("timeout")), TIMEOUT_MS);
  try {
    let line = `claude ${name}: no result message`;
    for await (const m of query({
      prompt: prompt(name),
      options: {
        cwd: projectDir,
        permissionMode: "default",
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: json },
        abortController: abort,
        canUseTool: async () => ({ behavior: "deny", message: "not permitted in this test" }),
      },
    })) {
      if (m.type === "result") {
        const text = (m as { structured_output?: unknown; result?: string }).structured_output ?? (m as { result?: string }).result;
        const value = typeof text === "string" ? JSON.parse(text) : text;
        fs.writeFileSync(path.join(outDir, `${name}.claude.json`), JSON.stringify(value, null, 2) + "\n");
        line = `claude ${name}: accepted, ${decodes(s, value) ? "decodes" : "DOES NOT DECODE"}, nesting depth ${depth(value)}`;
      }
    }
    say(`${line} (${Math.round((Date.now() - t1) / 1000)} s)`);
  } catch (e) {
    say(`claude ${name}: REJECTED: ${oneLine(e)} (${Math.round((Date.now() - t1) / 1000)} s)`);
  } finally {
    clearTimeout(timer);
  }
}

say(`\nReplies written to ${outDir}`);
