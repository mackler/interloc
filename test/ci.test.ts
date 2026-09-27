import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";

// A drift check between .github/workflows/ci.yml and the tools of this machine (the container image in development,
// the runner in CI), like test/deps.test.ts for the npm packages. It does not prove that the workflow runs on GitHub:
// that is the developer's check.
const root = new URL("../", import.meta.url);
const readText = (relative: string): string | undefined => {
  const file = new URL(relative, root);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
};
const workflow = (): string => readText(".github/workflows/ci.yml") ?? "(absent)";
const versionOf = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const match = /\d+\.\d+\.\d+/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.ok(match !== null, `${command} ${args.join(" ")} printed no version`);
  return match[0];
};
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the workflow sets up Node from .node-version", () => {
  assert.match(workflow(), /node-version-file: \.node-version/, "the workflow does not read .node-version");
});

test("the workflow installs bats at the version this machine runs, from the bats-core tag", () => {
  const bats = versionOf("bats", ["--version"]);
  assert.match(workflow(), /bats-core\/bats-core/, "the workflow does not install bats from bats-core");
  assert.match(workflow(), new RegExp(`--branch v${escape(bats)}\\b`), `the workflow does not install bats ${bats}`);
});

test("the workflow sets up this machine's Ruby and installs this machine's bashly with it, not with sudo", () => {
  const ruby = versionOf("ruby", ["-e", "print RUBY_VERSION"]);
  const bashly = versionOf("bashly", ["--version"]);
  assert.match(workflow(), /uses: ruby\/setup-ruby@/, "the workflow does not set up Ruby");
  assert.match(workflow(), new RegExp(`ruby-version: ["']?${escape(ruby)}["']?\\s`), `the workflow does not set up Ruby ${ruby}`);
  assert.match(workflow(), new RegExp(`gem install bashly -v ${escape(bashly)}\\b`), `the workflow does not install bashly ${bashly}`);
  assert.doesNotMatch(workflow(), /sudo gem install/, "bashly is installed with sudo, so with the runner's system Ruby");
});

test("the release job pushes to release with the deploy key, and the test job has a time limit", () => {
  assert.match(workflow(), /refs\/heads\/release/, "the workflow does not push to refs/heads/release");
  assert.match(workflow(), /secrets\.RELEASE_DEPLOY_KEY/, "the workflow does not use the secret RELEASE_DEPLOY_KEY");
  assert.match(workflow(), /timeout-minutes: \d+/, "the test job has no timeout-minutes");
});
