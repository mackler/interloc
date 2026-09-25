import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { defaultConfig } from "../src/schema.ts";
import { decodeConfigText, loadConfig } from "../src/config.ts";
import { platformLayer } from "../src/platform.ts";
import { tempRepo } from "./helpers.ts";

/** A project with a plan-review/ directory and a shared config file outside it. Neither file exists yet. */
const setup = (): { project: string; shared: string; projectFile: string } => {
  const project = tempRepo();
  fs.mkdirSync(path.join(project, "plan-review"), { recursive: true });
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr-shared-")), "config.json");
  return { project, shared, projectFile: path.join(project, "plan-review", "config.json") };
};

const load = (project: string, shared: string) => Effect.runPromise(loadConfig(project, shared).pipe(Effect.provide(platformLayer)));

const failsWith = async (project: string, shared: string, tag: RunError["_tag"], ...texts: RegExp[]): Promise<void> => {
  const exit = await Effect.runPromiseExit(loadConfig(project, shared).pipe(Effect.provide(platformLayer)));
  assert.ok(Exit.isFailure(exit), "the configuration was accepted");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
};

test("precedence: defaults, then shared, then project", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(shared, JSON.stringify({ maxRounds: 7, countMinor: false, ignorePaths: ["shared.txt"] }));
  fs.writeFileSync(projectFile, JSON.stringify({ maxRounds: 9, ignorePaths: ["project.txt"] }));
  const config = await load(project, shared);
  assert.equal(config.maxRounds, 9);
  assert.equal(config.countMinor, false);
  assert.equal(config.maxIdleRounds, defaultConfig.maxIdleRounds);
  assert.deepEqual(config.ignorePaths, ["project.txt"]);
});

test("missing config files give the defaults", async () => {
  const { project, shared } = setup();
  assert.deepEqual(await load(project, shared), defaultConfig);
});

for (const which of ["shared", "project"] as const) {
  const target = (files: ReturnType<typeof setup>): string => (which === "shared" ? files.shared : files.projectFile);

  test(`invalid JSON in the ${which} config fails with ConfigInvalid naming the file`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), "{");
    await failsWith(files.project, files.shared, "ConfigInvalid", new RegExp(target(files).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test(`a wrong type in the ${which} config fails with ConfigInvalid naming the field path`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRounds: "5" }));
    await failsWith(files.project, files.shared, "ConfigInvalid", /maxRounds/, new RegExp(path.basename(target(files))));
  });

  test(`an unknown key in the ${which} config fails with ConfigInvalid naming the key`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRound: 3 }));
    await failsWith(files.project, files.shared, "ConfigInvalid", /maxRound/);
  });
}

test("a wrong element type in a list names the element's path", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(projectFile, JSON.stringify({ ignorePaths: ["a.txt", 2] }));
  await failsWith(project, shared, "ConfigInvalid", /ignorePaths\[1\]/);
});

test("a round limit of 0 is reported with its field path", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(projectFile, JSON.stringify({ maxRounds: 0 }));
  await failsWith(project, shared, "ConfigInvalid", /maxRounds/);
});

// Finding 10: the config decoder returns a Result instead of throwing ConfigInvalid.
test("decodeConfigText returns a Result: ConfigInvalid for bad JSON or a wrong type, the partial config otherwise", () => {
  const badJson = decodeConfigText("/p/config.json", "{nope");
  assert.ok(Result.isFailure(badJson));
  assert.equal(badJson.failure._tag, "ConfigInvalid");
  assert.equal(badJson.failure.file, "/p/config.json");
  const wrongType = decodeConfigText("/p/config.json", '{"maxRounds": "5"}');
  assert.ok(Result.isFailure(wrongType));
  assert.equal(wrongType.failure.path, "maxRounds");
  const good = decodeConfigText("/p/config.json", '{"maxRounds": 3}');
  assert.ok(Result.isSuccess(good));
  assert.deepEqual(good.success, { maxRounds: 3 });
});
