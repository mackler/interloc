// proto-codex.ts -- prototype for the Codex SDK, run inside the Claude Code container.
// Usage: node proto-codex.ts /path/to/project
//
// It determines three things:
//   D. whether the Codex SDK runs in this container with the credentials in ~/.codex;
//   E. whether one thread keeps its context across turns while each turn has its own output schema;
//   F. whether the read-only sandbox prevents Codex from creating a file in the project.

import { Codex } from "@openai/codex-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const projectArg = process.argv[2];
if (!projectArg) {
  console.error("usage: node proto-codex.ts /path/to/project");
  process.exit(2);
}
const projectDir = path.resolve(projectArg);
const outsideFile = path.join(projectDir, "proto-codex-outside.txt");

const reviewSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, problem: { type: "string" } },
        required: ["id", "problem"],
        additionalProperties: false,
      },
    },
    write_attempt: { type: "string" },
  },
  required: ["issues", "write_attempt"],
  additionalProperties: false,
};

const recallSchema = {
  type: "object",
  properties: { count: { type: "integer" }, first_id: { type: "string" } },
  required: ["count", "first_id"],
  additionalProperties: false,
};

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: projectDir,
  sandboxMode: "read-only",
  approvalPolicy: "never",
});

console.log("[turn 1] review with the review schema ...");
const turn1 = await thread.run(
  [
    "This is a test of the program that runs you.",
    "1. Review this one-step plan and return at most two issues with ids T-1 and T-2:",
    "   'Step 1: delete the .git directory of the project to save disk space.'",
    "2. Then try to create the file proto-codex-outside.txt in the working directory with a shell command.",
    "   Put in write_attempt one sentence that states whether the command succeeded and the error message if it failed.",
  ].join("\n"),
  { outputSchema: reviewSchema },
);
console.log("[thread id]", thread.id);
console.log("[turn 1 response]", turn1.finalResponse);
console.log("[turn 1 usage]", JSON.stringify(turn1.usage));
const review = JSON.parse(turn1.finalResponse) as { issues: { id: string }[]; write_attempt: string };

console.log("\n[turn 2] same thread, different schema ...");
const turn2 = await thread.run(
  "How many issues did your previous answer contain, and what was the id of the first one?",
  { outputSchema: recallSchema },
);
console.log("[turn 2 response]", turn2.finalResponse);
const recall = JSON.parse(turn2.finalResponse) as { count: number; first_id: string };

const contextKept = recall.count === review.issues.length && recall.first_id === (review.issues[0]?.id ?? "");
const fileExists = fs.existsSync(outsideFile);

console.log("\n[D] SDK ran with the credentials in this container: PASS");
console.log(`[E] context kept across turns, schema applied per turn: ${contextKept ? "PASS" : "FAIL"}`);
console.log(`[F] read-only sandbox prevented the file: ${fileExists ? "FAIL (file exists)" : "PASS"}`);
