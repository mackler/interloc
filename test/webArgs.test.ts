import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PORT, distMissingMessage, parsePort } from "../src/webArgs.ts";

// Plan step 3.5 (Q4): `node src/web.ts [port]`, default 8090; the server refuses to start without the build.
test("parsePort: the default, a given port, and the invalid ones", () => {
  assert.equal(parsePort(["8091"]), 8091);
  assert.equal(parsePort([]), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 8090);
  for (const bad of ["0", "65536", "-1", "80.5", "abc", "8090x", ""]) assert.equal(parsePort([bad]), null, bad);
  assert.equal(parsePort(["8091", "extra"]), null);
});

test("distMissingMessage names the file and the command that builds it", () => {
  const text = distMissingMessage("/opt/plan-review/web/dist/index.html");
  assert.match(text, /\/opt\/plan-review\/web\/dist\/index\.html/);
  assert.match(text, /npm run build/);
});
