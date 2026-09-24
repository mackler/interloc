import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { State } from "../src/state.ts";
import { tempRepo } from "./helpers.ts";

const fails = (run: () => unknown, tag: RunError["_tag"], text: RegExp): void => {
  assert.throws(run, (e: unknown) => {
    const error = e as RunError;
    assert.equal(error._tag, tag);
    assert.match(describe(error), text);
    return true;
  });
};

test("an unreadable issue log fails with StateFileInvalid naming the file", () => {
  const state = new State(tempRepo());
  state.init("task");
  fs.writeFileSync(path.join(state.dir, "issue-log.json"), "{");
  fails(() => state.loadLog(), "StateFileInvalid", /issue-log\.json/);
});

test("git failure in the snapshot fails with GitError", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pr-nogit-"));
  fails(() => new State(outside).projectSnapshot(), "GitError", /git status/);
});

test("an unwritable plan-review directory fails with FileSystemError", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const state = new State(tempRepo());
  state.init("task");
  fs.chmodSync(state.dir, 0o500);
  try {
    fails(() => state.writeText(path.join(state.dir, "new.md"), "x"), "FileSystemError", /new\.md/);
  } finally {
    fs.chmodSync(state.dir, 0o700);
  }
});
