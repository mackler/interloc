# plan-review

A TypeScript program ("the orchestrator") that runs Claude Code and Codex against one project.
Claude Code writes a plan, Codex reviews it in rounds until a review contains no counted issue,
Claude Code implements the plan, and every stop during implementation leads to a plan revision
and a new review before work continues. The orchestrator contains no model calls of its own; it
starts both agents through their SDKs, passes text between them, keeps the records, and asks the
user for a decision at defined points. It is written with the Effect library (v4): the procedure
is one Effect program over five services, and the edges (files, git, terminal, SDKs) are layers.

## Commands

- `npm run check` — type check (`tsc --noEmit`). Must report nothing before every commit; `.githooks/pre-commit` runs it and refuses the commit otherwise. Enable the hook once per clone with `git config core.hooksPath .githooks`.
- `npm test` — type check, then the tests (`node --test test/*.test.ts`): scenario tests with scripted agents, the adapters over a fake SDK, the store on a temporary git repository, and `test/deps.test.ts`, which checks that the pinned versions are installed. A type error fails the tests before any test runs. No credentials needed; requires `git`.
- Real run, inside a project container that has both agents' credentials and network access:
  `node /opt/plan-review/src/main.ts "task description" [project directory]`

There is no build step. Node.js (22.18 or later) runs the `.ts` files directly by removing the types.

## TypeScript constraints (required by direct execution)

- Erasable syntax only: no `enum`, no parameter properties, no namespaces with runtime code (`erasableSyntaxOnly` enforces this). Effect's tagged error classes (`class X extends Data.TaggedError("X")<{…}> {}`), service classes (`Context.Service<X, Shape>()("key")`) and generator functions (`Effect.gen`) are erasable and are used.
- Type-only imports use `import type` (or inline `type`); Node.js does not remove unused value imports.
- Relative imports carry the `.ts` extension.
- Node.js does not type check. `npm run check` is the only type check.
- Every Effect and `@effect/platform-node` name used in the program is recorded in `docs/effect-v4-api.md` with the file and line of its declaration in `node_modules`. Look a name up there, or read the `.d.ts` file and add it, before using it. Material online describes v3 in most cases and is not a source.

## Layout

| File | Content |
|---|---|
| `src/main.ts` | Entry point: the live wiring and the platform runner (`NodeRuntime.runMain`) applied to the program; the only untested code besides `src/sdkLive.ts` |
| `src/program.ts` | `program(args, wiring)`: arguments, configuration, the services from the wiring, the run, and what is printed at the end; `exitCodeOf` |
| `src/run.ts` | Question phase, then alternation of planning phase K and execution phase K |
| `src/review.ts` | The review procedure (`reviewLoop`) with every pause condition; `planningCall`; `decodeWithRepair`; generic over a `Subject` |
| `src/subjects.ts` | The three subjects: question list, requirements, plan |
| `src/interview.ts` | Question phase and the interview in the terminal |
| `src/issueLog.ts` | Pure functions on the issue log (no I/O, no Effect). Detection of repeated issues, supersession, user decisions |
| `src/services.ts` | The five services (`Ui`, `Planner`, `Reviewer`, `Store`, `RunConfig`) and the `Sdk` service, with their error unions |
| `src/errors.ts` | The typed errors (one per cause that ends a run, and per I/O or parse failure), `describe`, `haltMessage` |
| `src/schema.ts` | One Effect Schema per kind of data: it gives the type, the JSON Schema for the agents, and the validation. `defaultConfig` |
| `src/jsonSchema.ts` | The JSON Schema the agents receive, generated from `src/schema.ts` (raw variant; strict transform as the fallback) |
| `src/claude.ts` | Claude Code through `@anthropic-ai/claude-agent-sdk`, as the `Planner` layer |
| `src/codex.ts` | Codex through `@openai/codex-sdk`, as the `Reviewer` layer |
| `src/sdk.ts`, `src/sdkLive.ts` | The `AgentSdk` interface the adapters use, and its binding to the real SDKs (untested) |
| `src/prompts.ts` | Every prompt text. Prompts are not written anywhere else |
| `src/store.ts` | The `Store` layer on Effect's FileSystem, Path and child-process services: files in `<project>/plan-review/`, the project snapshot, `loadConfig`; `platformLayer` |
| `src/state.ts` | `describeChange` (pure) and the decoders of the program's own JSON records |
| `src/ui.ts` | The `Ui` layer: one readline interface as a scoped resource |
| `test/helpers.ts` | `ScriptedUi`, `ScriptedPlanner`, `ScriptedReviewer` (the services, scripted), `testLayer`, `testWiring`, temporary git repository |
| `test/fakeSdk.ts` | A fake of the two SDKs for the adapter tests |
| `docs/effect-v4-api.md` | The API ledger: every Effect name used, with its declaration and the facts observed about it |
| `prototypes/` | The SDK prototypes and the schema acceptance prototype used to verify the environment; not part of the program |
| `.githooks/pre-commit` | Type check before each commit; not part of the program |

## Behaviour that is decided and must not change without the developer's instruction

1. The program waits for the user only where a decision is required. No confirmation prompts elsewhere.
2. Question phase before planning phase 1: Claude Code proposes a question list (question, reason, proposed answers, default); Codex reviews it; the interview takes place in the orchestrator's terminal; follow-up questions are unrestricted; Claude Code proposes the end with a summary and the user confirms; Codex reviews `requirements.md` for gaps, and accepted gaps lead to a second interview; an empty agreed list still offers the conversation.
3. Planning calls: Claude Code may write only under `plan-review/`. A `PreToolUse` hook denies other edits before they occur; the project snapshot comparison after each call is the second check.
4. Execution phases use `permissionMode: "auto"`. A call to `AskUserQuestion` is a stop: the answer is recorded, a hook then denies every tool except `StructuredOutput`, the turn ends, and the plan is always revised and reviewed before the next execution phase.
5. Codex runs with `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`, because bubblewrap cannot start in the containers. The program halts if the project or the reviewed file changed during a Codex turn. Codex keeps one thread per review loop.
6. Five dispositions (`accepted`, `partially_accepted`, `rejected`, `no_change_needed`, `clarification_requested`), self-corrections, and reviewer feedback. Every rationale is returned to Codex through the issue log.
7. Pause conditions in `reviewLoop`: repeated issue that was not accepted in full (same id, or new id reported through `duplicate_of`); reversal of an accepted correction; disputed self-correction; second clarification request for one id; identical file content to an earlier round; unexplained change; `maxIdleRounds` rounds without an accepted issue; round limit (`maxRounds`).
8. Records: `conversation.md` (readable, in order), JSON files per round, `usage.jsonl`, and `invalid-replies/` for agent replies that did not match their schema. A new run moves the previous run to `plan-review/archive-<time>/`.
9. Configuration precedence: defaults in `src/schema.ts`, then `config.json` in this repository (all projects), then `<project>/plan-review/config.json`. Invalid JSON, a wrong type or an unknown key in either file stops the program before any agent call and before the records are initialised (decision Q4 of the Effect rewrite).
10. Validation of agent replies (decision Q5): a structured reply of a planning, interview or review call that does not match its schema is kept in `invalid-replies/`, and the agent gets one repair turn in the same session or thread; a second mismatch stops the run. Execution reports get no repair turn: a recorded `AskUserQuestion` stop takes precedence, and an invalid report without a stop is treated like a missing one (status `aborted`).
11. Interruption (decision Q3): Ctrl+C aborts both SDK calls, closes the terminal interface, prints `INTERRUPTED by the user. State is preserved in …`, appends `**Interrupted by the user.**` to `conversation.md`, prints the Claude Code session id and the usage summary, and exits with code 130. A halt exits with 1, a missing task with 2.

## Facts established by runs in the developer's containers

Dates: 21 Sep 2026 (SDKs), 24 Sep 2026 (Effect).

- Agent SDK 0.3.278 (bundles Claude Code 2.1.278) uses the container's existing login; no API key.
- `AskUserQuestion` reaches `canUseTool` under `auto` mode. Resuming one session with a different permission mode per call works.
- Structured output is delivered through a tool named `StructuredOutput`; a hook that denies all tools also denies the final report.
- Codex SDK 0.155.1: one thread keeps context across turns, and each turn accepts its own `outputSchema`.
- Claude Code writes to its state file on every call. In the developer's projects that file is `.devcontainer/claude.json`, a tracked file inside the project, so `config.json` lists it under `ignorePaths`.
- Effect 4.0.0-rc.117 and `@effect/platform-node` 4.0.0-rc.117. Both agents accept the JSON Schema that `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` generates from the seven agent schemas: `prototypes/proto-schema.ts` made 28 calls (7 schemas × raw/strict × Codex/Agent SDK), all accepted and all replies decoded; the raw and strict variants were byte-identical. The program sends the raw variant (`prototypes/proto-schema-output/CHOSEN`); the strict transform stays as a tested fallback.
- `NodeRuntime.runMain` interrupts the main fiber on SIGINT or SIGTERM and then calls the teardown, which sets the exit code (read in the runner's implementation, `@effect/platform-node-shared/dist/NodeRuntime.js`). In terminal mode readline receives Ctrl+C itself; `src/ui.ts` passes it on as a real SIGINT.
- 25 Sep 2026, first real run after the Effect rewrite (a documentation task on a scratch project, in the development container, which has both agents' credentials and the installed program at `/opt/plan-review`): question phase with an empty agreed list, one planning phase, Codex convergence in round 1, one execution phase, `finished`; three Claude Code calls, two Codex turns; no agent process left running.
- `total_cost_usd` of the Agent SDK's result message is the running total of the session, and a resumed session continues from its saved total (the SDK's own description, confirmed in that run: 0.49, 1.06, 1.77 across the three calls of one session). `usage.jsonl` keeps the value of each call; the usage summary reports each session's last value.
- 25 Sep 2026, the interruption check (plan step 6.3, three runs in the development container): Ctrl+C at the `Enter = start planning` prompt, during a Codex review, and during the Claude Code planning call each ended with `INTERRUPTED by the user. State is preserved in …`, the session id and usage lines, `**Interrupted by the user.**` in `conversation.md`, exit code 130, and no `claude` or `codex` process left running. An aborted Codex turn or Claude Code call leaves no `usage.jsonl` line, because usage is recorded only from a completed result.

## Not yet known or not yet built

- The exchange between the agents (rejections, clarifications, pauses) and the repair turn have run only in scripted tests, not against the real agents: every real review so far returned zero issues in round 1.
- Resuming an interrupted run is not implemented. The developer wants it later.
- Threads that the orchestrator starts are stored in the same `~/.codex` volume as the developer's interactive Codex sessions; the effect on `codex resume --last` is unverified.

## Pinned versions

The two SDKs, `effect` and `@effect/platform-node` are pinned to exact versions (`test/deps.test.ts`
checks the pins and the installed versions), because the facts above were established on those
versions, each Agent SDK release bundles a new Claude Code, and Effect 4 is a release candidate whose
API may still move. The developer wants the program to stay current with all four, which are
released often, and does not want it to fall behind.

- At the start of every session in this repository, run `npm outdated` and tell the developer if
  any of the four has a newer version, before starting other work.
- Upgrade procedure for an SDK: change the version in `package.json`, `npm install`, `npm test`, run the matching
  prototype in `prototypes/` in a project container, then one real run. Update the version numbers
  and any changed facts in the section above, and commit.
- Upgrade procedure for Effect: bump `effect` and `@effect/platform-node` together, `npm install`, `npm test`,
  run `prototypes/proto-schema.ts` in a project container (the schema acceptance proof), then one real
  run. Check the names in `docs/effect-v4-api.md` against the new declarations, update the recorded
  versions and facts, and commit.
- An upgrade reaches real runs after `git pull` and `npm ci` in `~/work/plan-review`.

## Rules for changes

- Test first, without exception. Before application code is written or changed, the test that specifies it is written, run, and seen to fail for the reason the change is meant to fix (a failed assertion, or a type error naming the signature being changed; never a missing module or a typo). Then the least code that makes it pass. A new module may first be scaffolded with its final signature and a body that does nothing useful, so that the test fails on its assertion. The observed failure is recorded in the commit message.
- Every change to behaviour gets a scenario test in `test/` that runs the procedure against the test layers of `test/helpers.ts` (`testLayer`, `testWiring`). `src/issueLog.ts` stays free of I/O and of Effect services so that it can be tested directly.
- `src/claude.ts` and `src/codex.ts` receive the SDKs through the `Sdk` service and are tested with `test/fakeSdk.ts`. Only `src/sdkLive.ts` (the binding) and `src/main.ts` (the wiring and the runner) are untested; their text is shown to the developer before it is written. No scaffolding may reach a real agent: a scaffold of an adapter makes the SDK call impossible. Verify SDK option names against the type declarations in `node_modules`, not from memory.
- Do not add a dependency without the developer's instruction. Permitted besides the two SDKs: `effect` and `@effect/platform-node`.
- This directory is the development clone. The installed program is `~/work/plan-review` on the host, which project containers mount read-only at `/opt/plan-review`. A change here takes effect in real runs only after the developer merges it there with `git pull` and runs `npm ci` there when `package-lock.json` changed.
- `bin/dev-claude` starts the development container (`compose.cc.yaml`); it is not part of the program.

## Further context

`docs/history.md` records how the program came to its present form and what was tried and rejected. Read it before proposing a change to the architecture or to the container arrangement.
