import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { defaultConfig } from "../src/schema.ts";
import { State } from "../src/state.ts";
import { tempRepo } from "./helpers.ts";

/** A project with a plan-review/ directory and a shared config file outside it. Neither file exists yet. */
const setup = (): { state: State; shared: string; project: string } => {
  const state = new State(tempRepo());
  fs.mkdirSync(state.dir, { recursive: true });
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr-shared-")), "config.json");
  return { state, shared, project: path.join(state.dir, "config.json") };
};

const failsWith = (run: () => unknown, tag: RunError["_tag"], ...texts: RegExp[]): void => {
  assert.throws(run, (e: unknown) => {
    const error = e as RunError;
    assert.equal(error._tag, tag);
    for (const text of texts) assert.match(describe(error), text);
    return true;
  });
};

test("precedence: defaults, then shared, then project", () => {
  const { state, shared, project } = setup();
  fs.writeFileSync(shared, JSON.stringify({ maxRounds: 7, countMinor: false, ignorePaths: ["shared.txt"] }));
  fs.writeFileSync(project, JSON.stringify({ maxRounds: 9, ignorePaths: ["project.txt"] }));
  const config = state.loadConfig(shared, project);
  assert.equal(config.maxRounds, 9);
  assert.equal(config.countMinor, false);
  assert.equal(config.maxIdleRounds, defaultConfig.maxIdleRounds);
  assert.deepEqual(config.ignorePaths, ["project.txt"]);
  assert.deepEqual(state.ignorePaths, ["project.txt"]);
});

test("missing config files give the defaults", () => {
  const { state, shared, project } = setup();
  assert.deepEqual(state.loadConfig(shared, project), defaultConfig);
});

for (const which of ["shared", "project"] as const) {
  const target = (files: ReturnType<typeof setup>): string => files[which];

  test(`invalid JSON in the ${which} config fails with ConfigInvalid naming the file`, () => {
    const files = setup();
    fs.writeFileSync(target(files), "{");
    failsWith(() => files.state.loadConfig(files.shared, files.project), "ConfigInvalid", new RegExp(target(files).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test(`a wrong type in the ${which} config fails with ConfigInvalid naming the field path`, () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRounds: "5" }));
    failsWith(() => files.state.loadConfig(files.shared, files.project), "ConfigInvalid", /maxRounds/, new RegExp(path.basename(target(files))));
  });

  test(`an unknown key in the ${which} config fails with ConfigInvalid naming the key`, () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRound: 3 }));
    failsWith(() => files.state.loadConfig(files.shared, files.project), "ConfigInvalid", /maxRound/);
  });
}

test("a wrong element type in a list names the element's path", () => {
  const { state, shared, project } = setup();
  fs.writeFileSync(project, JSON.stringify({ ignorePaths: ["a.txt", 2] }));
  failsWith(() => state.loadConfig(shared, project), "ConfigInvalid", /ignorePaths\[1\]/);
});

test("the live loader reads plan-review/config.json of the project by default", () => {
  const { state, project } = setup();
  fs.writeFileSync(project, JSON.stringify({ maxRounds: 11 }));
  // The shared file of this repository sets only ignorePaths, so maxRounds comes from the project file.
  assert.equal(state.loadConfig().maxRounds, 11);
});
