import assert from "node:assert/strict";
import { test } from "node:test";
import { type Change, compareSnapshots, decodeStatusV2, excluded, renderChange, type Snapshot, type SnapshotEntry, type StatusRecord } from "../src/snapshot.ts";

// Decision Q1 (plan-review/requirements.md) and findings 1, 2 and 26 of docs/functional-design-review.md.

const H = "78981922613b2afb6025042ff6bd878ac1994e85";
const Z = "0000000000000000000000000000000000000000";
const nul = (...entries: string[]): string => entries.map((e) => e + "\0").join("");

test("decodeStatusV2 decodes changed, renamed, unmerged and untracked records; raw names with tabs, quotes and newlines", () => {
  const text = nul(
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 renamed.txt`, "a.txt",
    `1 AM N... 000000 100644 100644 ${Z} ${H} staged.txt`,
    `1 .M N... 100644 100644 100644 ${H} ${H} tab\there.txt`,
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.txt`,
    "? dangling",
    '? q"uote.txt',
    "? line\nbreak.txt",
  );
  const records = decodeStatusV2(text);
  assert.deepEqual(records, [
    { kind: "renamed", xy: "R.", sub: "N...", mH: "100644", mI: "100644", mW: "100644", hH: H, hI: H, score: "R100", path: "renamed.txt", origPath: "a.txt" },
    { kind: "changed", xy: "AM", sub: "N...", mH: "000000", mI: "100644", mW: "100644", hH: Z, hI: H, path: "staged.txt" },
    { kind: "changed", xy: ".M", sub: "N...", mH: "100644", mI: "100644", mW: "100644", hH: H, hI: H, path: "tab\there.txt" },
    { kind: "unmerged", xy: "UU", sub: "N...", path: "conflict.txt" },
    { kind: "untracked", path: "dangling" },
    { kind: "untracked", path: 'q"uote.txt' },
    { kind: "untracked", path: "line\nbreak.txt" },
  ] satisfies StatusRecord[]);
});

test("decodeStatusV2 is total: ignored entries, headers and unknown kinds are skipped, empty input gives no record", () => {
  assert.deepEqual(decodeStatusV2(""), []);
  assert.deepEqual(decodeStatusV2(nul("! ignored.txt", "# branch.oid abc", "x something else", "? kept.txt")), [{ kind: "untracked", path: "kept.txt" }]);
});

const entry = (record: StatusRecord, content: SnapshotEntry["content"]): SnapshotEntry => ({ record, content });
const untracked = (path: string): StatusRecord => ({ kind: "untracked", path });
const changed = (path: string, xy = ".M"): StatusRecord => ({ kind: "changed", xy, sub: "N...", mH: "100644", mI: "100644", mW: "100644", hH: H, hI: H, path });
const snapshot = (...entries: [string, SnapshotEntry][]): Snapshot => ({ entries: new Map(entries) });
const kinds = (changes: readonly Change[]): string[] => changes.map((c) => `${c.kind} ${c.path}`);

test("compareSnapshots: identical snapshots have no change; added, removed, status, type and content changes are told apart", () => {
  const file = entry(untracked("f"), { type: "file", hash: "h1" });
  const same = snapshot(["f", file], ["g", entry(changed("g"), { type: "file", hash: "h2" })]);
  assert.deepEqual(compareSnapshots(same, same), []);
  assert.deepEqual(kinds(compareSnapshots(snapshot(), snapshot(["f", file]))), ["added f"]);
  assert.deepEqual(kinds(compareSnapshots(snapshot(["f", file]), snapshot())), ["removed f"]);
  assert.deepEqual(kinds(compareSnapshots(snapshot(["g", entry(changed("g", ".M"), { type: "file", hash: "h" })]), snapshot(["g", entry(changed("g", "M."), { type: "file", hash: "h" })]))), ["status_changed g"]);
  assert.deepEqual(kinds(compareSnapshots(snapshot(["f", file]), snapshot(["f", entry(untracked("f"), { type: "file", hash: "h9" })]))), ["content_changed f"]);
  assert.deepEqual(kinds(compareSnapshots(snapshot(["f", file]), snapshot(["f", entry(untracked("f"), { type: "link", target: "t" })]))), ["type_changed f"]);
  assert.deepEqual(kinds(compareSnapshots(snapshot(["l", entry(untracked("l"), { type: "link", target: "t1" })]), snapshot(["l", entry(untracked("l"), { type: "link", target: "t2" })]))), ["content_changed l"]);
});

test("compareSnapshots: a regular file whose bytes spell a link is not a link, and the result is in path order whatever the map order", () => {
  const asFile = snapshot(["l", entry(untracked("l"), { type: "file", hash: "link:target.txt" })]);
  const asLink = snapshot(["l", entry(untracked("l"), { type: "link", target: "target.txt" })]);
  assert.deepEqual(kinds(compareSnapshots(asLink, asFile)), ["type_changed l"]);
  assert.deepEqual(kinds(compareSnapshots(asFile, asLink)), ["type_changed l"]);
  const a = entry(untracked("a"), { type: "file", hash: "1" });
  const b = entry(untracked("b"), { type: "file", hash: "1" });
  assert.deepEqual(kinds(compareSnapshots(snapshot(), snapshot(["b", b], ["a", a]))), ["added a", "added b"]);
  assert.deepEqual(compareSnapshots(snapshot(["b", b], ["a", a]), snapshot(["a", a], ["b", b])), []);
});

test("renderChange names the kind and the path, and from/to where they exist", () => {
  assert.match(renderChange({ kind: "added", path: "new.txt" }), /new\.txt/);
  assert.match(renderChange({ kind: "type_changed", path: "l", from: "link", to: "file" }), /l.*link.*file/);
  assert.notEqual(renderChange({ kind: "removed", path: "x" }), renderChange({ kind: "added", path: "x" }));
});

test("excluded: plan-review/ always; ignorePaths as a path or a directory prefix, respecting the boundary", () => {
  assert.equal(excluded("plan-review/plan.md", []), true);
  assert.equal(excluded("plan-review", []), false);
  assert.equal(excluded("a", ["a"]), true);
  assert.equal(excluded("a/b", ["a"]), true);
  assert.equal(excluded("ab/c", ["a"]), false);
  assert.equal(excluded("a/b", ["a/"]), true);
  assert.equal(excluded("b", ["a"]), false);
});
