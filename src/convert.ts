// Usage: node /opt/plan-review/src/convert.ts <plan-review directory>
// Rewrites the records of one run directory (or an archive) to version 2 (decision Q5's follow-up).
// Untested wiring, like main.ts: the converter itself is `convertPlanReviewDir` in src/records.ts, tested.

import { Effect, Exit } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as path from "node:path";
import { describe } from "./errors.ts";
import { platformLayer } from "./platform.ts";
import { convertPlanReviewDir } from "./records.ts";

const dir = process.argv[2];
const say = (text: string): Effect.Effect<void> => Effect.sync(() => void process.stdout.write(text + "\n"));
const warn = (text: string): Effect.Effect<void> => Effect.sync(() => void process.stderr.write(text + "\n"));

/** The exit code: 0 after a conversion, 1 after a halt, 2 without a directory argument. */
const program: Effect.Effect<number> =
  dir === undefined || dir === ""
    ? warn("usage: node convert.ts <plan-review directory>").pipe(Effect.as(2))
    : convertPlanReviewDir(path.resolve(dir)).pipe(
        Effect.flatMap((conversion) =>
          say(
            conversion.written.length === 0
              ? "Nothing to convert: every record is already version 2."
              : `Converted to version 2, ${conversion.written.length} file(s) written:\n${conversion.written.map((f) => `  ${f}`).join("\n")}`,
          ),
        ),
        Effect.as(0),
        Effect.catch((error) => warn(`HALTED: ${describe(error)}`).pipe(Effect.as(1))),
        Effect.provide(platformLayer),
      );

NodeRuntime.runMain(program, { teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) && typeof exit.value === "number" ? exit.value : 1) });
