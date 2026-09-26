import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

// No static import of effect or @effect/platform-node, so that the type check does not need them.
const root = new URL("../", import.meta.url);
const readJson = (relative: string): Record<string, any> | undefined => {
  const file = new URL(relative, root);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
};
const dependencies = (): Record<string, string> => readJson("package.json")?.dependencies ?? {};

test("effect and @effect/platform-node are pinned to exact versions", () => {
  const deps = dependencies();
  for (const name of ["effect", "@effect/platform-node"]) {
    assert.match(deps[name] ?? "(absent)", /^\d+\.\d+\.\d+(-rc\.\d+)?$/, `${name} is not pinned to an exact version`);
  }
  for (const [name, version] of Object.entries(deps)) {
    assert.doesNotMatch(version, /[\^~<>*x|]|latest/, `${name} has a version range: ${version}`);
  }
});

test("the installed effect version is the pinned one", () => {
  for (const name of ["effect", "@effect/platform-node"]) {
    const pinned = dependencies()[name];
    assert.ok(pinned !== undefined, `${name} is not a dependency`);
    assert.equal(readJson(`node_modules/${name}/package.json`)?.version, pinned, `installed ${name} differs from the pinned version`);
  }
});

// The devDependencies, each pinned exactly: fast-check (property tests) and those the developer instructed for the web GUI.
const PINNED_DEV = ["fast-check", "svelte", "vite", "@sveltejs/vite-plugin-svelte", "vitest", "@playwright/test", "marked", "dompurify", "m3-svelte", "vite-plugin-functions-mixins", "jsdom", "svelte-check"] as const;

for (const name of PINNED_DEV) {
  test(`${name} is a devDependency pinned to an exact version and the installed version matches`, () => {
    const pinned: string | undefined = readJson("package.json")?.devDependencies?.[name];
    assert.match(pinned ?? "(absent)", /^\d+\.\d+\.\d+$/, `${name} is not a devDependency pinned to an exact version`);
    assert.equal(readJson(`node_modules/${name}/package.json`)?.version, pinned, `installed ${name} differs from the pinned version`);
  });
}
