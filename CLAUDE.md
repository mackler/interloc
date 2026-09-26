# plan-review

A TypeScript program ("the orchestrator") that runs Claude Code and Codex against one project.
Claude Code writes a plan, Codex reviews it in rounds until a review contains no counted issue,
Claude Code implements the plan, and every stop during implementation leads to a plan revision
and a new review before work continues. The orchestrator contains no model calls of its own; it
starts both agents through their SDKs, passes text between them, keeps the records, and asks the
user for a decision at defined points. It is written with the Effect library (v4): the procedure
is one Effect program over five services, and the edges (files, git, terminal, SDKs) are layers.

## Commands

- `npm run check` — type check: `tsc --noEmit` (the program, tests, prototypes), `tsc --noEmit -p web` (the browser code under `web/src`) and `svelte-check` (the `.svelte` components). Must report nothing before every commit; `.githooks/pre-commit` runs it and refuses the commit otherwise. Enable the hook once per clone with `git config core.hooksPath .githooks`.
- `npm run build` — builds the page with Vite into `web/dist/` (git-ignored); the web server refuses to start without it.
- `npm run test:unit` (`node --test test/*.test.ts`), `npm run test:web` (Vitest over `web/src/**/*.test.ts`, jsdom), `npm run test:e2e` (Playwright against the server over scripted agents).
- `npm test` — type check, then the tests (`npm run test:unit`; `test:web`, the build and `test:e2e` join as their first tests exist): scenario tests with scripted agents, the adapters over a fake SDK, the store on a temporary git repository, and `test/deps.test.ts`, which checks that the pinned versions are installed. A type error fails the tests before any test runs. No credentials needed; requires `git`. The Playwright tests need Chromium and its system libraries in the container: a fresh container needs `npx playwright install chromium` as the user and `npx playwright install-deps chromium` as root, until the container image provides them.
- Real run, inside a project container that has both agents' credentials and network access:
  `node /opt/plan-review/src/main.ts "task description" [project directory]`
- Web GUI in such a container: `node /opt/plan-review/src/web.ts [port]` (default 8090; needs `npm run build` first), then open the page and start tasks there.

The program itself has no build step: Node.js (22.18 or later) runs the `.ts` files directly by removing the types. Only the page is built (`npm run build`).

## TypeScript constraints (required by direct execution)

- Erasable syntax only: no `enum`, no parameter properties, no namespaces with runtime code (`erasableSyntaxOnly` enforces this). Effect's tagged error classes (`class X extends Data.TaggedError("X")<{…}> {}`), service classes (`Context.Service<X, Shape>()("key")`) and generator functions (`Effect.gen`) are erasable and are used.
- Type-only imports use `import type` (or inline `type`); Node.js does not remove unused value imports.
- Relative imports carry the `.ts` extension.
- Node.js does not type check. `npm run check` is the only type check.
- Every Effect and `@effect/platform-node` name used in the program is recorded in `docs/effect-v4-api.md` with the file and line of its declaration in `node_modules`. Look a name up there, or read the `.d.ts` file and add it, before using it. Material online describes v3 in most cases and is not a source.

## Programming principles

The program follows functional programming: pure functions everywhere except at the edges, which are
identified as such (the layers of `src/store.ts`, `src/ui.ts`, `src/claude.ts`, `src/codex.ts`, and the
untested wiring); no exception is thrown — a failure is a typed error in the `Result` or the error
channel of an Effect, and a defect is a bug; data are immutable algebraic data types (readonly records,
tagged unions, `Result`, `Option`), never mutated after construction; recursion instead of iteration
where it is stack safe (`Effect.gen` and Effect's own combinators are, plain recursion over
unbounded input is not); effects are values, composed and run at the edge; and the rest that goes
with it: no shared mutable state, no `null`-or-throw signatures, no hidden preconditions,
exhaustiveness over variants, and a pure core that the tests exercise directly. The findings and
recommendations of `docs/functional-design-review.md` are the reference for what this means here.

## Layout

| File | Content |
|---|---|
| `src/main.ts` | Entry point: the live wiring and the platform runner (`NodeRuntime.runMain`) applied to the program; untested, like `src/sdkLive.ts` and `src/web.ts` |
| `src/web.ts` | The web GUI's entry point, `node src/web.ts [port]` (default 8090): the web server over the live wiring per run, under the platform runner; refuses to start without `web/dist/index.html`; untested wiring |
| `src/webArgs.ts` | The pure parts of `src/web.ts`: `parsePort`, the usage and the missing-build message |
| `src/webServer.ts` | The HTTP handler: the built page from `web/dist`, and one WebSocket per tab (hello, the replay, then the live events without those the replay holds; the page's start, answer, stop and list) |
| `src/runManager.ts` | One run at a time for the web GUI: start (the project path checked), answer and stop checked against the current run's id, the events of the current and the last run, broadcast with their per-run seq |
| `src/webUi.ts` | The `Ui` of a run in the page: every call becomes a `RunEvent`; a prompt waits for the first answer of any tab, interpreted as in the terminal |
| `src/protocol.ts` | The messages between the page and the server as Effect schemas (pure, also imported by the browser); `inSnapshot`, the replay boundary per replayed run |
| `src/program.ts` | `program(args, wiring)`: arguments, configuration, the services from the wiring, the run, and what is printed at the end; `exitCodeOf` |
| `src/run.ts` | Question phase, then alternation of planning phase K and execution phase K |
| `src/review.ts` | `reviewLoop` as the interpreter of `src/reviewState.ts` (it executes the commands against the services and feeds the events back); `planningCall`; `decodeWithRepair`; generic over a `Subject<R, D>` whose two planning operations are typed by their schemas |
| `src/reviewState.ts` | The review loop as a pure state machine: `advance(state, event)` returns the next state and the commands; every pause condition of behaviour 7, in its order, the log update and the progress checks live here. No I/O, no Effect |
| `src/usage.ts` | The usage summary as a pure fold over the lines of `usage.jsonl` (per-agent lines, each identified session's last running total, unidentified calls counted separately) and its rendering |
| `src/subjects.ts` | The three subjects: question list, requirements, plan; `writeQuestions` (normalised, then recorded) |
| `src/interview.ts` | The question phase |
| `src/conversation.ts` | The interview in the terminal (separate from the question phase so that the subjects can use it without an import cycle) |
| `src/artifacts.ts` | The catalog of the records (pure): `SubjectId`, `Artifact`, `pathOf`, `subjectDir`, `subjectOf`, `reviewedFile` — no workflow builds a path |
| `src/render.ts` | Markdown rendering of the records (pure): the round in `conversation.md`, the decision lines, the question lists, the subject headings |
| `src/config.ts` | `loadConfig` and `decodeConfigText` (behaviour 9) |
| `src/platform.ts` | `platformLayer`: the live FileSystem, Path and child-process services |
| `src/issueLog.ts` | Pure functions on the issue log (no I/O, no Effect). Detection of repeated issues, supersession, user decisions |
| `src/services.ts` | The five services (`Ui`, `Planner`, `Reviewer`, `Store`, `RunConfig`) and the `Sdk` service, with their error unions; `ReviewSession` (one thread per review loop, returned by `startPhase`); the path brands `ProjectPath` / `RecordPath` |
| `src/errors.ts` | The typed errors (one per cause that ends a run, and per I/O or parse failure), `describe` over their data, `decodeRunError` (a schema per tag) and `haltMessage` |
| `src/schema.ts` | One Effect Schema per kind of data: it gives the type, the JSON Schema for the agents, and the validation. `defaultConfig` |
| `src/jsonSchema.ts` | The JSON Schema the agents receive, generated from `src/schema.ts` (raw variant; the strict transform as the fallback, total: `Result<Json, UnsupportedSchema>`) |
| `src/claude.ts` | Claude Code through `@anthropic-ai/claude-agent-sdk`, as the `Planner` layer: stream consumption, cancellation, persistence, the hooks (edit targets resolved through symlinks) and the permission callbacks; the stop of an execution call is per call |
| `src/claudeEvents.ts` | Pure decoding of what the SDK hands the planner (`AskUserQuestion` input, edit targets), the reduction of a call's messages into its outcome (partial output explicit), and the execution outcome |
| `src/schemaNormalize.ts` | Variants after decoding (pure): interview turns, execution reports, and the question list (a default that names no proposed answer becomes null; duplicate or empty ids are `QuestionListInvalid`) |
| `src/records.ts` | The program's records on disk: the file shapes (`{ version: 2, entries }` logs, per-agent usage lines, `round-<n>.json`, `checkpoint.json`), their readers, and `readCheckpoint`, which verifies the records a checkpoint names |
| `src/codex.ts` | Codex through `@openai/codex-sdk`, as the `Reviewer` layer; each turn is streamed (`runStreamed`) and its events consumed inside the Effect |
| `src/codexEvents.ts` | Pure decoding of a streamed Codex turn: `toolEventOf` (one tool use per item id: commands and searches on `item.started`, file changes on `item.completed`) and `reduceTurn` (the last agent message, the usage, or the failure) |
| `src/uiEvents.ts` | `UiEvent`, the structured events of a run for a Ui (`UiShape.notify`, decision Q5): phases, rounds, reviews and responses, plan writes, execution outcomes, agent activity, relayed questions, interview turns; `describeEvent`, `phaseName` |
| `src/userPrompts.ts` | The widget catalog of the prompts to the user (pure): `promptOf(text)` gives the fixed choices with the exact text each sends, whether free text is meaningful, and the quit of the input mode; `numberedChoices` reads an interview message's numbered answers |
| `src/sdk.ts`, `src/sdkLive.ts` | The `AgentSdk` interface the adapters use, and `liveSdk()`, the factory that binds the real SDKs (untested) |
| `src/round.ts` | The validated round (pure): unique non-empty ids, one disposition per issue, references normalised, generated self-correction ids; `RoundInvalid` otherwise |
| `src/snapshot.ts` | The project snapshot (pure): git's porcelain v2 records decoded, the working-tree entry per path, `compareSnapshots`, the exclusion predicate |
| `src/prompts.ts` | Every prompt text, to the agents and to the user (the section "prompts to the user"). Prompts are not written anywhere else |
| `src/input.ts` | Pure interpretation of what the user types: the option a reply chooses, the extra rounds at the round limit, the `q` and `/quit` commands (shared by the terminal and the scripted Ui), the interview's `/done`, and the fold of the `"""` line protocol |
| `src/store.ts` | The `Store` layer on Effect's FileSystem, Path, child-process and Clock services: one domain operation per artifact of the catalog (JSON records written to a temporary name and renamed into place), the project snapshot, the checkpoint, the baseline tree and the change record of the work review (a temporary index in the git directory; the excluded paths removed literally) |
| `src/state.ts` | The decoders of the program's own JSON records, returning `Result` |
| `prototypes/classify.ts` | The classification of one call of the schema acceptance prototype (tested; the prototype counts `accepted && decoded` only) |
| `src/ui.ts` | The `Ui` layer: one readline interface as a scoped resource; the dialogue is serialized (a second concurrent `ask` waits) |
| `test/store.test.ts` | The work review's records in the store over a temporary repository: the baseline tree, `changes.diff`, the two hashes of the work subject |
| `test/workReview.test.ts` | Scenario tests of the work review: convergence, revise after an accepted issue or a self-correction, the three decision exits with `readCheckpoint`, the round limit without "p", the guards, stops before the work review |
| `test/helpers.ts` | `ScriptedUi`, `ScriptedPlanner`, `ScriptedReviewer` (the services, scripted), `testLayer`, `testWiring`, temporary git repository |
| `test/fakeSdk.ts` | A fake of the two SDKs for the adapter tests |
| `test/*.property.test.ts` | Property-based tests with `fast-check`, for the rows of the table in `docs/functional-design-review.md`, recommendation E |
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
7. Pause conditions in `reviewLoop`: repeated issue that was not accepted in full (same id, or new id reported through `duplicate_of`); reversal of an accepted correction; disputed self-correction; second clarification request for one id; identical file content to an earlier round; unexplained change; `maxIdleRounds` rounds without an accepted issue; round limit (`maxRounds`). Three policies of a subject (`src/reviewState.ts`): `proceed` (the "p" choice at the round limit, none for the work review), `leaveOnAcceptance` (a round with a correction due — an accepted or partially accepted disposition, or an effective self-correction `accepted` or `plan_error` — ends the loop with `revise` right after its log and the `logged` checkpoint), and `leaveOnDecision` (a non-empty decision at any pause ends the loop with `revise` instead of a planning call; the round, the decision's log entry and the checkpoint are written as far as the step allows, and every checkpoint written is one `readCheckpoint` accepts). Only the work review sets the last two.
8. Records: `conversation.md` (readable, in order), JSON files per round (`review-<n>.json` and `cc-<n>.json` are the agents' raw replies; `round-<n>.json` is the program's validated record of the round, `no_response` after the review and `validated` after the response), the four issue logs (`questions-log.json`, `requirements-log.json`, `issue-log.json`, `work-review-log.json`) as `{ version: 2, entries }` with entries tagged by `source`, `usage.jsonl` with one per-agent record per line, `questions.json`, `baseline.json` (the tree of the project at the start of the run, built in a temporary index), `work-review-<k>/changes.diff` (the diff from that tree to the current one, rewritten before every round of work review k), and `invalid-replies/` for agent replies that did not match their schema. Record files carry `version: 2`, and only that shape is read: the records of runs before 25 Sep 2026 (a bare array as a log, per-SDK usage lines, no version marker) are not readable by this program (decision Q5, narrowed by the developer the same day). JSON records are written to a temporary name and renamed into place, and `checkpoint.json` (`{ version: 2, subject, phase, round, stage, time }`) is replaced after all records of a transition are written: it identifies the last committed transition (decision Q6; no resume). A new run moves the previous run to `plan-review/archive-<time>/` (a second run in the same clock instant gets a `-2` suffix).
9. Configuration precedence: defaults in `src/schema.ts`, then `config.json` in this repository (all projects), then `<project>/plan-review/config.json`. Invalid JSON, a wrong type or an unknown key in either file stops the program before any agent call and before the records are initialised (decision Q4 of the Effect rewrite).
10. Validation of agent replies (decision Q5): a structured reply of a planning, interview or review call that does not match its schema is kept in `invalid-replies/`, and the agent gets one repair turn in the same session or thread; a second mismatch stops the run. Execution reports get no repair turn: a recorded `AskUserQuestion` stop takes precedence, and an invalid report without a stop is treated like a missing one (status `aborted`).
11. Interruption (decision Q3): Ctrl+C aborts both SDK calls, closes the terminal interface, prints `INTERRUPTED by the user. State is preserved in …`, appends `**Interrupted by the user.**` to `conversation.md`, prints the Claude Code session id and the usage summary, and exits with code 130. A halt exits with 1, a missing task with 2.
12. The work review (the web GUI task, 26 Sep 2026): after every execution phase, whatever its status (a stop's input is recorded first), Codex reviews `work-review-<k>/changes.diff` and the project against `plan.md` and `requirements.md`, in rounds under behaviours 5, 6, 7 and 10, in its own thread, log (`work-review-log.json`) and subject directory (`work-review-<k>/`), ids `W<k>-R<n>-<i>`. Claude Code answers without changing any file. A correction due or any user decision at a pause leads to the next planning phase (the plan is revised from the round record, the log and `user-decisions.md`, reviewed, executed, and reviewed again); the round limit offers no "p". The run is finished only when the execution reported `finished` and its work review converged. The guard of behaviour 5 compares, besides the project, the recomputed diff and the bytes of `changes.diff`.

## User interface

Adherence to Jakob Nielsen's ten usability heuristics is a top priority for every user interface of
this program, the terminal and the web page alike: visibility of system status; match between the
system and the real world; user control and freedom; consistency and standards; error prevention;
recognition rather than recall; flexibility and efficiency of use; aesthetic and minimalist design;
help users recognize, diagnose, and recover from errors; help and documentation. A design decision
about the interface is argued from these heuristics, and a review of the interface checks against them.
The visual design follows Material Design (Google's design system, m3.material.io): its components,
layout, typography, colour roles, elevation, motion and states. A component library that implements it
is a dependency and needs the developer's instruction like any other; without one, the guidelines are
followed by hand.

## Facts established by runs in the developer's containers

Dates: 21 Sep 2026 (SDKs), 24 Sep 2026 (Effect).

- Agent SDK 0.3.283 (bundles Claude Code 2.1.283; upgraded from 0.3.278 on 26 Sep 2026 because Opus 5.5 requires Claude Code 2.1.280 or newer — the SDK's bundled Claude Code, not the container's `claude`, is what a run uses) uses the container's existing login; no API key. The prototype `prototypes/proto.ts` passed on 0.3.283 (26 Sep 2026: login credentials, hook denial, `AskUserQuestion` and permission requests in `canUseTool`); the real run of the upgrade procedure is the next run.
- `AskUserQuestion` reaches `canUseTool` under `auto` mode. Resuming one session with a different permission mode per call works.
- Structured output is delivered through a tool named `StructuredOutput`; a hook that denies all tools also denies the final report.
- Codex SDK 0.155.1: one thread keeps context across turns, and each turn accepts its own `outputSchema`. (Established with `thread.run`; the adapter now uses `thread.runStreamed`, and the fact is to be re-verified in the real run of the web GUI's stage 6.)
- Claude Code writes to its state file on every call. In the developer's projects that file is `.devcontainer/claude.json`, a tracked file inside the project, so `config.json` lists it under `ignorePaths`.
- Effect 4.0.0-rc.117 and `@effect/platform-node` 4.0.0-rc.117. Both agents accept the JSON Schema that `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` generates from the seven agent schemas: `prototypes/proto-schema.ts` made 28 calls (7 schemas × raw/strict × Codex/Agent SDK), all accepted and all replies decoded; the raw and strict variants were byte-identical. The program sends the raw variant (`prototypes/proto-schema-output/CHOSEN`); the strict transform stays as a tested fallback.
- `NodeRuntime.runMain` interrupts the main fiber on SIGINT or SIGTERM and then calls the teardown, which sets the exit code (read in the runner's implementation, `@effect/platform-node-shared/dist/NodeRuntime.js`). In terminal mode readline receives Ctrl+C itself; `src/ui.ts` passes it on as a real SIGINT.
- 25 Sep 2026, first real run after the Effect rewrite (a documentation task on a scratch project, in the development container, which has both agents' credentials and the installed program at `/opt/plan-review`): question phase with an empty agreed list, one planning phase, Codex convergence in round 1, one execution phase, `finished`; three Claude Code calls, two Codex turns; no agent process left running.
- `total_cost_usd` of the Agent SDK's result message is the running total of the session, and a resumed session continues from its saved total (the SDK's own description, confirmed in that run: 0.49, 1.06, 1.77 across the three calls of one session). `usage.jsonl` keeps the value of each call; the usage summary reports each session's last value.
- The project snapshot (decision Q1 of the functional design review, 25 Sep 2026): `git status --porcelain=v2 -z --untracked-files=all`, every listed path with its record and its working-tree entry — a regular file's content hash, a symbolic link's target (the link itself), a directory, or missing. It detects edits of untracked files, staged replacements, renames and retargeted links; gitignored files are unobserved. `plan-review/` and `ignorePaths` are excluded by one predicate.
- 25 Sep 2026, the interruption check (plan step 6.3, three runs in the development container): Ctrl+C at the `Enter = start planning` prompt, during a Codex review, and during the Claude Code planning call each ended with `INTERRUPTED by the user. State is preserved in …`, the session id and usage lines, `**Interrupted by the user.**` in `conversation.md`, exit code 130, and no `claude` or `codex` process left running. An aborted Codex turn or Claude Code call leaves no `usage.jsonl` line, because usage is recorded only from a completed result.

## Not yet known or not yet built

- The exchange between the agents has run for real once (25 Sep 2026, the plan for the functional design review: 6, 4 and 1 issues in three rounds, all accepted); rejections, clarifications, the pause conditions and the repair turn have run only in scripted tests. That run also showed Codex's turns growing with the thread (147k to 1.35M input tokens over seven turns) until its usage limit halted the run.
- Resuming an interrupted run is not implemented. The developer wants it later; `plan-review/checkpoint.json` identifies the last committed transition, and `readCheckpoint` in `src/records.ts` verifies that the records it names exist and decode.
- Threads that the orchestrator starts are stored in the same `~/.codex` volume as the developer's interactive Codex sessions; the effect on `codex resume --last` is unverified.

## Pinned versions

The two SDKs, `effect`, `@effect/platform-node` and the test dependency `fast-check` are pinned to
exact versions (`test/deps.test.ts` checks the pins and the installed versions), because the facts
above were established on those versions, each Agent SDK release bundles a new Claude Code, and
Effect 4 is a release candidate whose API may still move. The developer wants the program to stay
current with all five, which are released often, and does not want it to fall behind.

- At the start of every session in this repository, run `npm outdated` and tell the developer if
  any of the five has a newer version, before starting other work. For `effect`, `npm outdated`
  shows the `latest` tag (3.x); the relevant tag is `rc` (or a final 4.x): `npm view effect dist-tags`.
- `fast-check` (4.10.2, added 25 Sep 2026 on the developer's instruction) is used only for the
  property-based tests that `docs/functional-design-review.md`, recommendation E, names; every other
  test is an example test. Upgrading it is `npm install --save-dev --save-exact fast-check@<version>`
  and `npm test`.
- Upgrade procedure for an SDK: change the version in `package.json`, `npm install`, `npm test`, run the matching
  prototype in `prototypes/` in a project container, then one real run. Update the version numbers
  and any changed facts in the section above, and commit.
- Upgrade procedure for Effect: bump `effect` and `@effect/platform-node` together, `npm install`, `npm test`,
  run `prototypes/proto-schema.ts` in a project container (the schema acceptance proof), then one real
  run. Check the names in `docs/effect-v4-api.md` against the new declarations, update the recorded
  versions and facts, and commit.
- The web GUI's devDependencies (listed under Rules for changes) are pinned too. `vite` stays on 7.x
  and `@sveltejs/vite-plugin-svelte` on 6.x until `vite-plugin-functions-mixins` accepts Vite 8 (0.4.1
  declares `vite ^7.2.4`; plugin-svelte 7.x requires Vite 8), so the session-start check reports their
  8.x/7.x releases as blocked, not simply outdated.
- An upgrade reaches real runs after `git pull`, `npm ci` and `npm run build` in `~/work/plan-review`.
  `npm ci` is needed whenever `package-lock.json` changed; `npm run build` whenever the page changed.

## Rules for changes

- Test first, without exception. Before application code is written or changed, the test that specifies it is written, run, and seen to fail for the reason the change is meant to fix (a failed assertion, or a type error naming the signature being changed; never a missing module or a typo). Then the least code that makes it pass. A new module may first be scaffolded with its final signature and a body that does nothing useful, so that the test fails on its assertion. The observed failure is recorded in the commit message.
- Every change to behaviour gets a scenario test in `test/` that runs the procedure against the test layers of `test/helpers.ts` (`testLayer`, `testWiring`). `src/issueLog.ts` stays free of I/O and of Effect services so that it can be tested directly.
- `src/claude.ts` and `src/codex.ts` receive the SDKs through the `Sdk` service and are tested with `test/fakeSdk.ts`. Only `src/sdkLive.ts` (the binding), `src/main.ts` and `src/web.ts` (the wirings and the runner) are untested; their text is shown to the developer before it is written. No scaffolding may reach a real agent: a scaffold of an adapter makes the SDK call impossible. Verify SDK option names against the type declarations in `node_modules`, not from memory.
- Do not add a dependency without the developer's instruction. Permitted besides the two SDKs: `effect`, `@effect/platform-node`, and these devDependencies, each pinned exactly and checked by `test/deps.test.ts`: `fast-check` (property tests); for the web GUI (instructed 26 Sep 2026) `svelte` (the page), `vite` and `@sveltejs/vite-plugin-svelte` (the build), `vitest` (component tests), `jsdom` (the DOM for Vitest), `svelte-check` (type check of `.svelte` files), `@playwright/test` (end-to-end tests), `marked` and `dompurify` (Markdown rendering and sanitising in the page), `m3-svelte` (Material Design 3 components) and `vite-plugin-functions-mixins` (the CSS `@function`/`@mixin` of m3-svelte's components, resolved at build time).
- This directory is the development clone. The installed program is `~/work/plan-review` on the host, which project containers mount read-only at `/opt/plan-review`. A change here takes effect in real runs only after the developer merges it there with `git pull`, runs `npm ci` there when `package-lock.json` changed, and `npm run build` for the page.
- `bin/dev-claude` starts the development container (`compose.cc.yaml`); it is not part of the program.

## Further context

`docs/history.md` records how the program came to its present form and what was tried and rejected. Read it before proposing a change to the architecture or to the container arrangement.
