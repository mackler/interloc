import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import type { StoreShape } from "../src/services.ts";
import { makeStore, platformLayer } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

/** The store of a repository, built on the live platform services. */
const store = (repo: string, ignorePaths: readonly string[] = []): Promise<StoreShape> => Effect.runPromise(makeStore(repo, ignorePaths).pipe(Effect.provide(platformLayer)));

/** A store on a temporary repository with the records initialised. */
const initialised = async (): Promise<StoreShape> => {
  const s = await store(tempRepo());
  await Effect.runPromise(s.init("task"));
  return s;
};

const fails = async (effect: Effect.Effect<unknown, RunError>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
};

test("an unreadable issue log fails with StateFileInvalid naming the file", async () => {
  const s = await initialised();
  fs.writeFileSync(path.join(s.dir, "issue-log.json"), "{");
  await fails(s.loadLog(), "StateFileInvalid", /issue-log\.json/);
});

test("git failure in the snapshot fails with GitError", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pr-nogit-"));
  const s = await store(outside);
  await fails(s.projectSnapshot(), "GitError", /git status/);
});

test("an unwritable plan-review directory fails with FileSystemError", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const s = await initialised();
  fs.chmodSync(s.dir, 0o500);
  try {
    await fails(s.writeText(path.join(s.dir, "new.md"), "x"), "FileSystemError", /new\.md/);
  } finally {
    fs.chmodSync(s.dir, 0o700);
  }
});

test("an issue log entry with an unknown action source fails with StateFileInvalid", async () => {
  const s = await initialised();
  const entry = { id: "A", phase: 1, round: 1, source: "robot", problem: "p", action: "accepted", rationale: "r" };
  fs.writeFileSync(path.join(s.dir, "issue-log.json"), JSON.stringify([entry]));
  await fails(s.loadLog(), "StateFileInvalid", /issue-log\.json/, /source/);
});

test("questions.json without questions fails with StateFileInvalid", async () => {
  const s = await initialised();
  fs.writeFileSync(s.questions, JSON.stringify({ task: "t" }));
  await fails(s.loadQuestions(), "StateFileInvalid", /questions\.json/, /questions/);
});

test("loadQuestions returns the agreed list", async () => {
  const s = await initialised();
  const question = { id: "Q1", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "A" };
  fs.writeFileSync(s.questions, JSON.stringify({ task: "t", questions: [question] }));
  assert.deepEqual((await Effect.runPromise(s.loadQuestions())).questions, [question]);
});

test("a usage.jsonl line that is not an object fails with StateFileInvalid", async () => {
  const s = await initialised();
  fs.writeFileSync(path.join(s.dir, "usage.jsonl"), '{"time":"t","agent":"claude","total_cost_usd":1}\n42\n');
  await fails(s.usageSummary(), "StateFileInvalid", /usage\.jsonl/);
});

test("init archives an earlier run and keeps config.json; the records are written", async () => {
  const s = await initialised();
  fs.writeFileSync(path.join(s.dir, "config.json"), "{}");
  await Effect.runPromise(s.init("second"));
  const names = fs.readdirSync(s.dir);
  assert.equal(names.filter((n) => n.startsWith("archive-")).length, 1);
  assert.ok(names.includes("config.json"));
  assert.match(fs.readFileSync(path.join(s.dir, "conversation.md"), "utf8"), /Task: second/);
  assert.deepEqual(await Effect.runPromise(s.loadLog()), []);
});

test("the records: decisions, feedback, usage and the invalid-reply files", async () => {
  const s = await initialised();
  await Effect.runPromise(s.recordDecision("issue A", "keep it"));
  await Effect.runPromise(s.recordFeedback("Planning phase 1", 2, "too strict"));
  await Effect.runPromise(s.recordUsage({ agent: "claude", total_cost_usd: 1.5 }));
  await Effect.runPromise(s.recordUsage({ agent: "codex", usage: { input_tokens: 10, output_tokens: 5 } }));
  assert.match(fs.readFileSync(path.join(s.dir, "user-decisions.md"), "utf8"), /Subject: issue A\nDecision: keep it/);
  assert.match(fs.readFileSync(path.join(s.dir, "conversation.md"), "utf8"), /\*\*User decision\*\* on issue A: keep it/);
  assert.match(fs.readFileSync(path.join(s.dir, "reviewer-feedback.md"), "utf8"), /## Planning phase 1, round 2\ntoo strict/);
  assert.match(await Effect.runPromise(s.usageSummary()), /Claude Code: 1 calls in 1 sessions, total_cost_usd = 1\.50 .* Codex: 1 turns, 10 input tokens, 5 output tokens/);
  assert.equal(await Effect.runPromise(s.saveInvalidReply("codex", "x")), path.join("plan-review", "invalid-replies", "codex-1.json"));
  assert.equal(await Effect.runPromise(s.saveInvalidReply("codex", "y")), path.join("plan-review", "invalid-replies", "codex-2.json"));
  assert.equal(fs.readFileSync(path.join(s.dir, "invalid-replies", "codex-2.json"), "utf8"), "y");
});

test("planExists, fileHash and subDir", async () => {
  const s = await initialised();
  assert.equal(await Effect.runPromise(s.planExists()), false);
  await Effect.runPromise(s.writeText(s.plan, ""));
  assert.equal(await Effect.runPromise(s.planExists()), false);
  await Effect.runPromise(s.writeText(s.plan, "v1"));
  assert.equal(await Effect.runPromise(s.planExists()), true);
  assert.equal(await Effect.runPromise(s.fileHash(path.join(s.dir, "absent"))), "");
  assert.notEqual(await Effect.runPromise(s.fileHash(s.plan)), "");
  const dir = await Effect.runPromise(s.subDir("planning-1"));
  assert.ok(fs.statSync(dir).isDirectory());
});

test("the snapshot reflects the repository and ignores plan-review/ and the ignored paths", async () => {
  const repo = tempRepo();
  const s = await store(repo, ["ignored.txt"]);
  await Effect.runPromise(s.init("task"));
  fs.appendFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "i\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual(snapshot.status, [" M a.txt", "?? new.txt"]);
  assert.deepEqual([...snapshot.diffs.keys()], ["a.txt"]);
});

// The command service seen by the store: a fake spawner that records the arguments and answers
// with fixed output, so the test shows which git commands the snapshot runs.
type Spawn = Parameters<typeof ChildProcessSpawner.make>[0];
const recordingSpawner = (answer: (args: readonly string[]) => string): { layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>; commands: string[][] } => {
  const commands: string[][] = [];
  const spawn: Spawn = (command) => {
    if (command._tag !== "StandardCommand") throw new Error("piped commands are not expected");
    const args = [command.command, ...command.args];
    commands.push(args);
    const stdout = Stream.make(new TextEncoder().encode(answer(command.args)));
    const handle = {
      pid: 1,
      exitCode: Effect.succeed(0),
      isRunning: Effect.succeed(false),
      kill: () => Effect.succeed(undefined),
      stdout,
      stderr: Stream.empty,
      all: stdout,
    } as unknown as ChildProcessSpawner.ChildProcessHandle;
    return Effect.succeed(handle);
  };
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)), commands };
};

test("the snapshot runs git through the command service", async () => {
  const repo = tempRepo();
  const { layer, commands } = recordingSpawner((args) => {
    if (args.includes("status")) return " M a.txt\0 M ignored.txt\0?? plan-review/plan.md\0";
    if (args.includes("--name-only")) return "a.txt\0ignored.txt\0";
    return "diff of a.txt";
  });
  const platform = Layer.mergeAll(platformLayer, layer);
  const s = await Effect.runPromise(makeStore(repo, ["ignored.txt"]).pipe(Effect.provide(platform)));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual(snapshot.status, [" M a.txt"]);
  assert.deepEqual([...snapshot.diffs.keys()], ["a.txt"]);
  assert.deepEqual(commands, [
    ["git", "-C", repo, "status", "--porcelain", "-z"],
    ["git", "-C", repo, "diff", "--name-only", "-z"],
    ["git", "-C", repo, "diff", "--", "a.txt"],
  ]);
});

test("usageSummary reports the running total of each Claude Code session, not the sum of the calls", async () => {
  // The Agent SDK's total_cost_usd is cumulative for a session, and a resumed session continues from
  // its saved total, so every call of one session reports the total so far (observed in the run of 25 Sep 2026).
  const s = await initialised();
  await Effect.runPromise(s.recordUsage({ agent: "claude", session_id: "s-1", num_turns: 6, total_cost_usd: 0.5 }));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session_id: "s-1", num_turns: 4, total_cost_usd: 1.25 }));
  await Effect.runPromise(s.recordUsage({ agent: "claude", session_id: "s-2", num_turns: 2, total_cost_usd: 0.25 }));
  assert.match(await Effect.runPromise(s.usageSummary()), /Claude Code: 3 calls in 2 sessions, total_cost_usd = 1\.50 \(the sessions' last reported running totals, an estimate by the client\)/);
});

// Finding 1 of docs/functional-design-review.md: describeChange ignored diff entries that appear or disappear.
test("describeChange reports a diff entry that appears or disappears, and nothing for a snapshot compared with itself", async () => {
  const { describeChange } = await import("../src/state.ts");
  const before = { status: [" M a.txt"], diffs: new Map<string, string>() };
  const after = { status: [" M a.txt"], diffs: new Map([["a.txt", "h1"]]) };
  assert.notDeepEqual(describeChange(before, after), [], "an added diff entry was not reported");
  assert.notDeepEqual(describeChange(after, before), [], "a removed diff entry was not reported");
  assert.deepEqual(describeChange(after, after), []);
  assert.deepEqual(describeChange(before, before), []);
});

// Finding 22 of docs/functional-design-review.md: the time was read and the JSON serialized when the
// effect was built, not when it ran; a serialization failure was a defect.
test("recordUsage reads the time when it runs, and the store owns the time", async () => {
  const s = await initialised();
  const once = s.recordUsage({ agent: "claude", session_id: "s", total_cost_usd: 1 });
  await Effect.runPromise(once);
  await new Promise((resolve) => setTimeout(resolve, 3));
  await Effect.runPromise(once);
  await Effect.runPromise(s.recordUsage({ agent: "claude", session_id: "s", total_cost_usd: 2, time: "1999" }));
  const lines = fs.readFileSync(path.join(s.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.notEqual(lines[0].time, lines[1].time, "one effect run twice recorded the same time");
  assert.notEqual(lines[2].time, "1999", "the entry's own time overrode the store's");
});

test("writeJson of a value that cannot be serialized fails with FileSystemError (serialize), not a defect", async () => {
  const s = await initialised();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await fails(s.writeJson(path.join(s.dir, "x.json"), cyclic), "FileSystemError", /serialize/, /x\.json/);
});

// Finding 2 of docs/functional-design-review.md: plan-review/ was filtered from the status but not from the diff
// names, and git's C-quoted names were undone only by stripping the quotes. The fake git answers in the quoted
// form unless asked for -z, as git does.
const gitAnswers = (repo: string, entries: { status: string; name: string; diff: boolean }[]) => (args: readonly string[]): string => {
  const z = args.includes("-z");
  const quote = (name: string): string => (/[\t"\\ ]/.test(name) ? `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"` : name);
  const render = (name: string): string => (z ? name : quote(name));
  if (args.includes("status")) return entries.map((e) => `${e.status} ${render(e.name)}${z ? "\0" : "\n"}`).join("");
  if (args.includes("--name-only")) return entries.filter((e) => e.diff).map((e) => `${render(e.name)}${z ? "\0" : "\n"}`).join("");
  void repo;
  return "diff text";
};

test("plan-review/ is excluded from the diff names as it is from the status, and no diff of it is requested", async () => {
  const repo = tempRepo();
  const { layer, commands } = recordingSpawner(gitAnswers(repo, [{ status: " M", name: "a.txt", diff: true }, { status: "??", name: "plan-review/plan.md", diff: true }]));
  const s = await Effect.runPromise(makeStore(repo, []).pipe(Effect.provide(Layer.mergeAll(platformLayer, layer))));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual(snapshot.status, [" M a.txt"]);
  assert.deepEqual([...snapshot.diffs.keys()], ["a.txt"]);
  assert.ok(!commands.some((c) => c.includes("plan-review/plan.md")), `a git command named plan-review/plan.md: ${JSON.stringify(commands)}`);
});

test("names with tabs and quotes are the real names: matched against ignorePaths and passed to git diff as they are", async () => {
  const repo = tempRepo();
  const { layer, commands } = recordingSpawner(gitAnswers(repo, [{ status: "??", name: "tab\there.txt", diff: false }, { status: " M", name: 'q"uote.txt', diff: true }]));
  const s = await Effect.runPromise(makeStore(repo, ["tab\there.txt"]).pipe(Effect.provide(Layer.mergeAll(platformLayer, layer))));
  const snapshot = await Effect.runPromise(s.projectSnapshot());
  assert.deepEqual(snapshot.status, [' M q"uote.txt']);
  assert.deepEqual([...snapshot.diffs.keys()], ['q"uote.txt']);
  assert.ok(commands.some((c) => c.slice(-3).join(" ") === 'diff -- q"uote.txt'), `no diff of the real name: ${JSON.stringify(commands)}`);
  assert.ok(!commands.some((c) => c.some((a) => a.includes("\\"))), `an escaped name reached git: ${JSON.stringify(commands)}`);
});
