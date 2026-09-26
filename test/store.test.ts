import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { platformLayer } from "../src/platform.ts";
import type { StoreShape } from "../src/services.ts";
import { makeStore } from "../src/store.ts";
import { compareRecords } from "../src/snapshot.ts";
import { tempRepo } from "./helpers.ts";

// Plan step 2.3 (decision Q7; P1-R1-5, P1-R2-1, P1-R2-2, P4-R1-1): the baseline tree at init, the change
// record before each work-review turn, and the two hashes of the work subject.
const run = Effect.runPromise;
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const commit = (dir: string, message: string) => git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", message);
const write = (dir: string, name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};
const storeOf = (repo: string, ignorePaths: readonly string[] = []): Promise<StoreShape> => run(makeStore(repo, ignorePaths).pipe(Effect.provide(platformLayer)));
const changes = (repo: string, phase = 1): string => fs.readFileSync(path.join(repo, "plan-review", `work-review-${phase}`, "changes.diff"), "utf8");

test("init records the baseline tree, and the change record holds new, modified and committed changes", async () => {
  const repo = tempRepo();
  // tempRepo does not ignore plan-review/, so a temporary index under it could be staged (P1-R2-1).
  write(repo, "b.txt", "b\n");
  git(repo, "add", "b.txt");
  commit(repo, "b");
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const store = await storeOf(repo);
  await run(store.init("task"));
  const baseline = JSON.parse(fs.readFileSync(path.join(repo, "plan-review", "baseline.json"), "utf8"));
  assert.equal(baseline.version, 2);
  assert.equal(git(repo, "cat-file", "-t", baseline.tree).trim(), "tree");
  assert.ok(!git(repo, "ls-tree", "-r", "--name-only", baseline.tree).includes("plan-review/"), "the baseline tree contains plan-review/");

  write(repo, "new.txt", "brand new\n");
  write(repo, "a.txt", "x\nmodified\n");
  write(repo, "b.txt", "b\ncommitted later\n");
  commit(repo, "after init");
  await run(store.changeRecord(1));
  const diff = changes(repo);
  assert.match(diff, /\+brand new/, "the new file is not in the diff");
  assert.match(diff, /\+modified/);
  assert.match(diff, /\+committed later/);
  assert.doesNotMatch(diff, /plan-review\//);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")).equals(indexBefore) || git(repo, "diff", "--cached", "--name-only").trim() === "", true, "the repository's own index changed");
  assert.deepEqual(fs.readdirSync(path.join(repo, ".git")).filter((n) => n.startsWith("plan-review-index")), [], "a temporary index is left");
});

test("the change record leaves out ignorePaths literally and keeps tracked files that match .gitignore", async () => {
  const repo = tempRepo();
  write(repo, "src/run.ts", "run\n");
  write(repo, "src/[rs]*.ts", "literal\n");
  write(repo, "tracked.log", "log\n");
  git(repo, "add", "-f", "src/run.ts", "src/[rs]*.ts", "tracked.log");
  commit(repo, "files");
  write(repo, ".gitignore", "*.log\n");
  const store = await storeOf(repo, ["src/[rs]*.ts", ".devcontainer/claude.json"]);
  await run(store.init("task"));
  write(repo, "src/run.ts", "run\nchanged\n");
  write(repo, "src/[rs]*.ts", "literal\nchanged\n");
  write(repo, "tracked.log", "log\nchanged\n");
  write(repo, ".devcontainer/claude.json", "{}\n");
  await run(store.changeRecord(1));
  const diff = changes(repo);
  assert.match(diff, /src\/run\.ts/, "a file matching the ignorePaths entry as a pattern was left out");
  assert.doesNotMatch(diff, /\[rs\]\*/, "the literal ignorePaths entry is in the diff");
  assert.doesNotMatch(diff, /claude\.json/);
  assert.match(diff, /tracked\.log/, "a tracked file matching .gitignore is not observed");
});

test("changeRecord rewrites the file; fileHash of the work subject follows the project, recordHash the file on disk", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  assert.equal(await run(store.fileHash({ work: 1 })), "", "fileHash before init");
  await run(store.init("task"));
  const before = await run(store.fileHash({ work: 1 }));
  write(repo, "a.txt", "x\nfirst\n");
  await run(store.changeRecord(1));
  const first = await run(store.fileHash({ work: 1 }));
  assert.notEqual(first, before);
  assert.equal(await run(store.recordHash({ work: 1 })), await run(store.recordHash({ work: 1 })));
  write(repo, "a.txt", "x\nsecond\n");
  await run(store.changeRecord(1));
  assert.match(changes(repo), /\+second/);
  // An edit of changes.diff itself changes recordHash but not fileHash (P1-R2-2).
  const hashes = { file: await run(store.fileHash({ work: 1 })), record: await run(store.recordHash({ work: 1 })) };
  fs.appendFileSync(path.join(repo, "plan-review", "work-review-1", "changes.diff"), "edited\n");
  assert.equal(await run(store.fileHash({ work: 1 })), hashes.file);
  assert.notEqual(await run(store.recordHash({ work: 1 })), hashes.record);
  // For the other subjects the two hashes are the same.
  fs.writeFileSync(store.plan, "plan\n");
  assert.equal(await run(store.recordHash({ plan: 1 })), await run(store.fileHash({ plan: 1 })));
});

// Stage A (finding 1 of docs/gui-review.md): the records snapshot that a read-only call is checked with.
test("recordsSnapshot changes with every guarded record and not with usage.jsonl or invalid-replies/", async () => {
  const repo = tempRepo();
  const store = await storeOf(repo);
  await run(store.init("task"));
  const dir = path.join(repo, "plan-review");
  for (const [name, text] of [["plan.md", "p"], ["requirements.md", "r"], ["work-review-1/changes.diff", "d"], ["work-review-1/round-1.json", "{}"], ["checkpoint.json", "{}"]] as const) write(dir, name, text);
  const moved = async (change: () => void): Promise<number> => {
    const before = await run(store.recordsSnapshot());
    change();
    return compareRecords(before, await run(store.recordsSnapshot())).length;
  };
  for (const name of ["plan.md", "requirements.md", "work-review-1/changes.diff", "work-review-1/round-1.json", "checkpoint.json", "baseline.json"]) {
    assert.equal(await moved(() => fs.appendFileSync(path.join(dir, name), "x")), 1, `rewritten: ${name}`);
  }
  assert.equal(await moved(() => fs.rmSync(path.join(dir, "requirements.md"))), 1, "deleted");
  assert.equal(await moved(() => write(dir, "notes/new.md", "n")), 2, "a new file and its new directory");
  assert.equal(await moved(() => fs.appendFileSync(path.join(dir, "usage.jsonl"), "{}\n")), 0, "usage.jsonl");
  assert.equal(await moved(() => write(dir, "invalid-replies/claude-1.json", "{}")), 0, "invalid-replies/");
});
