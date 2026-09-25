import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

// Finding 28: the modules of src/ form a directed acyclic graph of value imports (type-only imports are erased).
const SRC = path.join(import.meta.dirname, "..", "src");
const VALUE_IMPORT = /^import (?!type\b)[^;]*?from "\.\/([A-Za-z]+\.ts)"/gm;

const graph = (): Map<string, string[]> => {
  const edges = new Map<string, string[]>();
  for (const name of fs.readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort()) {
    const text = fs.readFileSync(path.join(SRC, name), "utf8");
    edges.set(name, [...text.matchAll(VALUE_IMPORT)].map((m) => m[1]));
  }
  return edges;
};

/** The first cycle found by depth-first search, as the names along it, or null. */
const findCycle = (edges: Map<string, string[]>): string[] | null => {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of edges.keys()) {
    const found = visit(node);
    if (found !== null) return found;
  }
  return null;
};

test("the value-import graph of src/ has no cycle", () => {
  const cycle = findCycle(graph());
  assert.equal(cycle, null, `import cycle: ${cycle?.join(" -> ")}`);
});

test("the cycle finder sees a cycle", () => {
  assert.deepEqual(findCycle(new Map([["a.ts", ["b.ts"]], ["b.ts", ["a.ts"]]])), ["a.ts", "b.ts", "a.ts"]);
  assert.equal(findCycle(new Map([["a.ts", ["b.ts"]], ["b.ts", []]])), null);
});
