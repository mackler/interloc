import { test } from "node:test";
import type { Effect } from "effect";
import type { Wiring } from "../src/program.ts";
import type { PlanningResult, StoreShape, UiShape } from "../src/services.ts";

// Finding 26: the records the procedure exchanges are readonly views (compile-time; no runtime freezing in production code).
// The function is never called: the statements exist for the type checker.
function mutations(result: PlanningResult, wiring: Wiring, ui: UiShape, log: ReturnType<StoreShape["loadLog"]> extends Effect.Effect<infer A, unknown, unknown> ? A : never): void {
  // @ts-expect-error a planning result is not mutated after it is produced
  result.resultText = "";
  // @ts-expect-error the wiring is fixed when the program starts
  wiring.cwd = "/elsewhere";
  // @ts-expect-error a service's methods are not replaced
  ui.say = () => null as unknown as Effect.Effect<void>;
  // @ts-expect-error the loaded log is a readonly view; the log functions return new logs
  log.push(log[0]);
}

test("the exchanged records are readonly (compile-time)", () => {
  void mutations;
});
