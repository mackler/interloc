# Interloq

A TypeScript program ("the orchestrator") that runs Claude Code and Codex against one project.
Claude Code writes a plan, Codex reviews it in rounds until a review contains no counted issue,
Claude Code implements the plan, Codex reviews the work after every execution phase, and every
stop or accepted work issue leads to a plan revision and a new review before work continues.
The user follows and answers in the terminal (`src/main.ts`) or in a web page (`src/web.ts`). The orchestrator contains no model calls of its own; it
starts both agents through their SDKs, passes text between them, keeps the records, and asks the
user for a decision at defined points. It is written with the Effect library (v4): the procedure
is one Effect program over five services, and the edges (files, git, terminal, SDKs) are layers.

## Commands

- `npm run check` — type check: `tsc --noEmit` (the program, tests, prototypes), `tsc --noEmit -p web` (the browser code under `web/src`) and `svelte-check` (the `.svelte` components). Must report nothing before every commit; `.githooks/pre-commit` runs it and refuses the commit otherwise. Enable the hook once per clone with `git config core.hooksPath .githooks`.
- `npm run build` — builds the page with Vite into `web/dist/` (git-ignored); the web server refuses to start without it.
- `npm run test:unit` (`node --test test/*.test.ts`), `npm run test:web` (Vitest over `web/src/**/*.test.ts`, jsdom), `npm run test:e2e` (Playwright against the server over scripted agents), `npm run test:cli` (`bats test/cli`: `bin/ilcli` over temporary git repositories, with `docker` and `npm` replaced by the stubs in `test/cli/stubs/`).
- `npm run generate:cli` — regenerates `bin/ilcli` from `bin/ilcli.bashly/` with bashly (2.0.0, provided by the container image; the host has none, so the generated script is committed). Run it after every change of `bin/ilcli.bashly/`; `test/cli/generated.bats` fails until the committed script is what bashly generates.
- `npm test` — type check, then the tests: `npm run test:unit`, `npm run test:cli`, `npm run test:web`, `npm run build`, `npm run test:e2e` — scenario tests with scripted agents, the adapters over a fake SDK, the store on a temporary git repository, and `test/deps.test.ts`, which checks that the pinned versions are installed. A type error fails the tests before any test runs. No credentials needed; requires `git`. The tools these need beyond npm — Playwright's Chromium, bashly (2.0.0) and bats (1.11.1) — all come from `container/Dockerfile`, so a container built from it needs no manual installation. A container built before 27 Sep 2026 lacks bats, and `npm test` then fails at `test:cli`: rebuild with `bin/ilcli build`, `down` and `shell`.
- Real run, inside a project container that has both agents' credentials and network access:
  `node /opt/interloq/src/main.ts "task description" [project directory]`
- Web GUI in such a container: `node /opt/interloq/src/web.ts [port]` (default 8090; needs `npm run build` first), then open the page and start tasks there.
- `bin/ilcli release` — on the host, in the development clone: pushes `main` to GitHub (refuses on uncommitted changes, another branch, or a `main` behind `origin/main`). `bin/ilcli upgrade` — on the host, in the installed copy: fetches `release`, fast-forwards, then `npm ci` and `npm run build` every time. `bin/ilcli help` documents every command.

The program itself has no build step: Node.js (22.18 or later) runs the `.ts` files directly by removing the types. Only the page is built (`npm run build`).

The minimum, Node.js 22.18, is enforced: `package.json` declares `engines` `>=22.18` and `.npmrc` sets `engine-strict=true`, so `npm ci` refuses an older Node. `.node-version` holds the exact Node version of the container image (26.10.0 on 27 Sep 2026), which the CI workflow uses; update it whenever the image's Node changes — `test/deps.test.ts` fails until it matches the running Node.

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
| `src/webServer.ts` | `makeWebServer` → `{ handler, closeAll }` (`closeAll` sends each tab `closing` and closes its socket; src/web.ts registers it after `serveEffect`). The HTTP handler: `requestTarget` (a malformed URL or percent-encoding is a 400, never a defect), the built page from `web/dist`, and one WebSocket per tab (hello, the replay, then the live events without those the replay holds; the page's start, answer, stop and list); each tab's forwarding queue is bounded (`subscribeBounded`, 1,000 events), and a tab that falls that far behind is told and closed and recovers by replay |
| `src/runManager.ts` | One run at a time for the web GUI: start (the project must be a worktree's top-level directory; the run reserved with its fiber in one uninterruptible step), answer and stop checked against the server's incarnation and the current run's id, `makePublisher` (record and offer as one serialized, uninterruptible step), the events of the current and the last run, broadcast with their per-run seq; every event stamped with its publication time (issue #1), read from the Clock in `append` and `end` before the serialized step, so seq, not the time, is the order |
| `src/webUi.ts` | The `Ui` of a run in the page: every call becomes a `RunEvent`; a prompt waits for the first answer of any tab, interpreted as in the terminal; an answer is taken, published and delivered in one uninterruptible step |
| `src/protocol.ts` | The messages between the page and the server as Effect schemas (pure, also imported by the browser); `inSnapshot`, the replay boundary per replayed run; the incarnation (one start of the server) in `hello`, `answer` and `stop`; `closing`; `Stamped` (an event with its publication time): a run record's entries and the live `event` frame carry the time beside the event (issue #1) |
| `src/program.ts` | `program(args, wiring)`: arguments, configuration, the services from the wiring, the run, and what is printed at the end; `exitCodeOf` |
| `src/run.ts` | Question phase, then alternation of planning phase K and execution phase K |
| `src/review.ts` | `reviewLoop` as the interpreter of `src/reviewState.ts` (it executes the commands against the services and feeds the events back); `planningCall` with its capability (`records`, or `readOnly` with the records snapshot as its second check); `decodeWithRepair`; generic over a `Subject<R, D>` whose two planning operations are typed by their schemas |
| `src/reviewState.ts` | The review loop as a pure state machine: `advance(state, event)` returns the next state and the commands; every pause condition of behaviour 7, in its order, the log update and the progress checks live here. No I/O, no Effect |
| `src/usage.ts` | The usage summary as a pure fold over the lines of `usage.jsonl` (per-agent lines, each identified session's last running total, unidentified calls counted separately) and its rendering |
| `src/subjects.ts` | The three subjects: question list, requirements, plan; `writeQuestions` (normalised, then recorded) |
| `src/interview.ts` | The question phase |
| `src/conversation.ts` | The interview in the terminal (separate from the question phase so that the subjects can use it without an import cycle); the user reads "Clarification", "Follow-up clarification" or "Conversation before planning", while `conversation.md` keeps its record headings (`recordHeading` in `src/render.ts`), and each turn is notified with its count (issue #21) |
| `src/artifacts.ts` | The catalog of the records (pure): `SubjectId` (with `{ decision: k }`), `Artifact` (with a decision's question, analysis, raw output and choice), `pathOf`, `subjectDir`, `subjectOf`, `reviewedFile`, `guardedRecord` (the records a read-only call must leave unchanged) — no workflow builds a path |
| `src/render.ts` | Markdown rendering of the records (pure): the round in `conversation.md`, the decision lines, the question lists, the subject headings |
| `src/config.ts` | `loadConfig` and `decodeConfigText` (behaviour 9) |
| `src/platform.ts` | `platformLayer`: the live FileSystem, Path and child-process services |
| `src/issueLog.ts` | Pure functions on the issue log (no I/O, no Effect). Detection of repeated issues, supersession, user decisions; `correctionCount`, the corrections of one response as the progress rail counts them (issue #14) |
| `src/services.ts` | The six services (`Ui`, `Planner`, `Reviewer`, `Store`, `RunConfig`, `Decider`) and the `Sdk` service, with their error unions; the Planner's `fresh` (a new session, for a decision loop); `ReviewSession` (one thread per review loop, returned by `startPhase`); the path brands `ProjectPath` / `RecordPath` |
| `src/errors.ts` | The typed errors (one per cause that ends a run, and per I/O or parse failure), `describe` over their data, `decodeRunError` (a schema per tag) and `haltMessage` |
| `src/schema.ts` | One Effect Schema per kind of data: it gives the type, the JSON Schema for the agents, and the validation. `defaultConfig`. `UserQuestion` (a question for the user with its options, decision Q1 of decision support); `DecisionAnalysis`, the representation of `docs/decision-making.md` as data, recursive through `Schema.suspend` with an object at its root |
| `src/jsonSchema.ts` | The JSON Schema the agents receive, generated from `src/schema.ts` (raw variant; the strict transform as the fallback, total: `Result<Json, UnsupportedSchema>`) |
| `src/claude.ts` | Claude Code through `@anthropic-ai/claude-agent-sdk`, as the `Planner` layer: stream consumption, cancellation, persistence, the hooks (edit targets resolved through symlinks; the read-only capability's hook without a matcher) and the permission callbacks; the stop of an execution call is per call; a relayed question with options and a permission request carry the offer of decision support, with the Decider of the call |
| `src/claudeEvents.ts` | Pure decoding of what the SDK hands the planner (`AskUserQuestion` input, edit targets), the reduction of a call's messages into its outcome (partial output explicit), and the execution outcome |
| `src/schemaNormalize.ts` | Variants after decoding (pure): interview turns, execution reports, and the question list (a default that names no proposed answer becomes null; duplicate or empty ids are `QuestionListInvalid`); an interview turn keeps `asked` and `answered`, and `clarificationCount` gives "x of N answered", N the agreed and the asked questions (issue #21) |
| `src/records.ts` | The program's records on disk: the file shapes (`{ version: 2, entries }` logs, per-agent usage lines, `round-<n>.json`, `checkpoint.json`, a decision's `question.json`, `analysis.json` and `chosen.json`), their readers, and `readCheckpoint`, which verifies the records a checkpoint names |
| `src/codex.ts` | Codex through `@openai/codex-sdk`, as the `Reviewer` layer; each turn is streamed (`runStreamed`) and its events consumed inside the Effect |
| `src/codexEvents.ts` | Pure decoding of a streamed Codex turn: `toolEventOf` (one tool use per item id: commands and searches on `item.started`, file changes on `item.completed`) and `reduceTurn` (the last agent message, the usage, or the failure) |
| `src/uiEvents.ts` | `UiEvent`, the structured events of a run for a Ui (`UiShape.notify`, decision Q5): phases, rounds, reviews and responses, plan writes, execution outcomes, agent activity, relayed questions, interview turns, the interview's opening (`InterviewOpened`, printed by the terminal with its `"""` help; the page shows its own), Claude Code's prose during execution (`ClaudeSaid`, issue #5: attributed as data; the terminal prints it with its `[claude] ` prefix, the page as Claude's message); `describeEvent`, `phaseName`; `InterviewOpened` carries the stage (`clarification`, `followUp`, `conversation`) and the total, `InterviewTurn` the answered count and the total (issue #21); `phaseName` says "Gather Requirements" and "Implementation" (issue #14); decision support adds `OptionsPresented` (the options of the next pause or plan writer's question) and `DecisionAnalyzed` (a decision's analysis) |
| `src/userPrompts.ts` | The widget catalog of the prompts to the user (pure): `promptOf(text)` gives the fixed choices with the exact text each sends, whether free text is meaningful, and the quit of the input mode; a text with the offer line of decision support has "Help me Decide" (sends `/decide`) before Quit; `numberedChoices` reads an interview message's numbered answers |
| `src/decision.ts` | Decision support: `decisionLoop` (the analysis call in a fresh session, `acceptAnalysis`, `reviewLoop` over `decisionSubject`) and the `Decider` layer, which runs a loop over the run's captured services from any prompt, SDK callbacks included, bound to the phase in which the question is asked |
| `src/offer.ts` | The offer of decision support: `askOffering` (the offer on a question with two or more options; `/decide` runs a decision, shows it, presents the question again and asks again; the answer is recorded as the choice of each decision made for it) and the options with the answers that choose them (numbered, a permission request, the cycle limit) |
| `src/analysisView.ts` | A decision's analysis as the page and the terminal show it (pure, also imported by the browser): `viewOf` places the heading "Disadvantages:", flattens the counterarguments with their levels, and assigns the equivalence symbols (`symbolFor`: *, †, ‡, §, ‖, ¶, then doubled, then tripled) to the referenced entries in their order in the columns |
| `src/analysis.ts` | The validation of a decision analysis beyond its schema (pure): `validateAnalysis`, `AnalysisInvalid`, a dangling reference dropped with a note |
| `src/sdk.ts`, `src/sdkLive.ts` | The `AgentSdk` interface the adapters use, and `liveSdk()`, the factory that binds the real SDKs (untested) |
| `src/round.ts` | The validated round (pure): unique non-empty ids, one disposition per issue, references normalised, generated self-correction ids; `RoundInvalid` otherwise |
| `src/snapshot.ts` | The project snapshot (pure): git's porcelain v2 records decoded, the working-tree entry per path, `compareSnapshots`, the exclusion predicate |
| `src/prompts.ts` | Every prompt text, to the agents and to the user (the section "prompts to the user"), and the page's help and notices (the answer hint, the withdrawn draft, the server's end, the actions not sent, the compact progress line and badge). Prompts are not written anywhere else; the user-facing words of issues #14 and #21 ("Gather Requirements", "Implementation", "cycle", "clarification"), while the records and the prompts to the agents keep "round", "execution" and "interview" |
| `src/input.ts` | Pure interpretation of what the user types: the option a reply chooses, the extra rounds at the round limit, the `q` and `/quit` commands (shared by the terminal and the scripted Ui), the interview's `/done`, decision support's `/decide` and `answerOf` (a number stands for its option), and the fold of the `"""` line protocol |
| `src/store.ts` | The `Store` layer on Effect's FileSystem, Path, child-process and Clock services: one domain operation per artifact of the catalog (JSON records written to a temporary name and renamed into place), the project snapshot, the records snapshot of a read-only call, the checkpoint, the baseline tree and the change record of the work review (a temporary index in the git directory; the excluded paths removed literally), and a decision's records (`openDecision` allocates k by creating `decision-<k>/`; the shared `decision-log.json` merged per decision) |
| `src/state.ts` | The decoders of the program's own JSON records, returning `Result` |
| `prototypes/classify.ts` | The classification of one call of the schema acceptance prototype (tested; the prototype counts `accepted && decoded` only) |
| `src/ui.ts` | The `Ui` layer: one readline interface as a scoped resource; the dialogue is serialized (a second concurrent `ask` waits) |
| `web/` | The page: `index.html`, `vite.config.ts` (build into `web/dist`, the CSS mixins of m3-svelte, Vitest in jsdom), `tsconfig.json` (DOM lib) |
| `web/src/state.ts` | The page's pure reducer over the server's messages: the two panels, the pending prompt with the agent's options (an interview turn's numbered answers, a relayed question's options) apart from its fixed choices (issue #12), the activity line, the timeline rail; replay and live events fold alike; the connection (including `failed`), one notice per run of unreadable frames, and the answers not sent kept until dismissed; Claude's prose and the interview's turns as Claude's messages, and "Claude" wherever the page names Claude Code (issue #5); Markdown in the left panel for Claude's prose, the interview's turns, the questions Claude relays (one message of Claude, their terminal lines absorbed), the plan writes and the user's answers, while Interloq's lines, prompts and interview help stay plain text (issue #7); each message's publication time and `showTime` (`showsTime`: the first of its panel, another author, or more than 2 minutes after the last time the panel displayed; issue #1, issue #15); each message's phase band (`Band`, set at `PhaseBegan`, `bandsOf` groups a panel's messages), whose label shows the time the phase began and counts as displayed, so the band's first message shows its own time only more than 2 minutes after it (issue #15); each review loop in the timeline with its cycles (the issues raised and counted), its corrections and its result, and Gather Requirements with its steps (Formulate questions, Clarification, Follow-up clarification), each with its cycles and the clarification's count; `progressOf`, the compact progress line (issues #14 and #21); decision support: presented options as the next prompt's cards, cleared by every prompt, a decision's analysis kept until the prompt asked after it is answered, and no decision loop in the timeline |
| `web/src/socket.ts` | The page's WebSocket: reconnection with backoff (reset by a decoded replay, not by the hello), the queue of actions until the hello (an action for an ended run, or of an earlier incarnation of the server, is discarded with a notice); a frame that does not decode is logged to the console, reported with its reason and renewed with backoff, and after three in a row the page is `failed`: no reconnection, and every queued or later action is handed back unsent (`docs/page-question-phase-defects.md`, defect B) |
| `web/src/markdown.ts` | The agents' Markdown rendered with marked and sanitised by a private DOMPurify instance (`makeRenderer`; the imported singleton is never configured) |
| `web/src/time.ts` | A message's time as the page shows it (pure, total): `clockTime` (HH:MM:SS in the browser's locale and time zone) and `fullTime` (the title) |
| `web/src/layout.ts` | The layout state below M3's expanded width (pure): the selected panel, the hidden panel's unseen count, a new prompt (by its full key: incarnation, run, prompt) selecting "You and Interloq"; both panels stay mounted and a hidden one scrolls to its end when shown again if it was following (`ChatPanel`'s `visible`) |
| `web/src/draft.ts` | The unsent text of the pending prompt (pure): keyed by (incarnation, run, prompt), reconciled with the view after every message, live or replayed; another tab's answer withdraws it with a notice; an answer the failed page could not send goes back to an empty field or is quoted, never over newer text (`restoreUnsent`) |
| `web/src/storage.ts` | The remembered project directory: an edge over `localStorage` whose acquisition, read and write failures are typed results; Start never depends on it |
| `web/src/components/*.svelte` | The components over m3-svelte: `App`, `TopBar`, `StartForm`, `DirectoryDialog`, `TimelineRail`, `ChatPanel`, `Message`, `PromptWidget`, `ActivityLine`, `DecisionView` (a decision's analysis over both chat columns until its question is answered: one column per option, at least 20rem wide, scrolling sideways when they do not fit; below 390 px a message; the conversation one click away); `web/src/theme.css` (M3 styles, the tonal-spot scheme, the density function); `Message` shows its time in its header as `<time>`, visually hidden when grouped; `ChatPanel` shows each phase as a band of one subtle tone per kind of phase, opened by a label with the phase's name and start time (issue #15); `PromptWidget` shows the agent's options as outlined M3 cards with their full text, above the fixed choices' buttons (issue #12); `TimelineRail` shows a running loop as "cycle n: o issues" lines and a finished one as a single line, with no limit (issue #14), and the steps of Gather Requirements with their counts (issue #21) |
| `web/src/*.test.ts` | Vitest: the reducer (with a fast-check property), the socket over a fake WebSocket, the Markdown, the components mounted in jsdom (`test-setup.ts` supplies `matchMedia` and the dialog methods jsdom lacks) |
| `e2e/server.ts`, `e2e/run.spec.ts`, `e2e/fixtures.ts`, `e2e/longAnswers.ts`, `playwright.config.ts` | The end-to-end tests: the real web server and run manager over the scripted agents of `test/helpers.ts` in a temporary repository, one server per scenario (`converge`, `decision`, `stop`, `interview`, `workCorrection`, `tabs`, `drop`, `long`, `questionReview`, `longChoices`: an interview turn whose numbered answers are paragraphs, issue #12; `decide`: "Help me Decide" on a question with two options), and fourteen Playwright tests in Chromium (the thirteen numbered scenarios and the fixture's check), plus `e2e/layout.spec.ts` with thirteen tests (390 × 844, 640 × 400 and 1280 × 800: L1–L8; L9, the paragraph options, at 390 × 844 and at 1280 × 800; L10–L12, a decision's analysis at 1280 × 800, 390 × 844 and 360 × 640); the fixture fails a test on an uncaught error or a console error in any page of its context (finding 10 of `docs/gui-review.md`) |
| `docs/ui-review.md` | The review of the page against Nielsen's ten heuristics and Material Design 3 |
| `docs/decision-making.md` | The developer's instructions for representing the arguments for and against the options of a decision: the authority for the content and layout of every decision analysis. Not to be changed without the developer's instruction |
| `docs/decision-support-design.md` | The agreed design of decision support ("Help me Decide"): the rule, the prompts it applies to, the loop, the records, the schema, the context, the presentation and the cost |
| `test/store.test.ts` | The work review's records in the store over a temporary repository: the baseline tree, `changes.diff`, the two hashes of the work subject |
| `test/replayCapacity.test.ts` | The measurement of finding 13: a run of 10,000 events through the manager and its replay to one client over the real server, bounded by the criterion of decision Q4 (1 s, 50 MB) |
| `test/workReview.test.ts` | Scenario tests of the work review: convergence, revise after an accepted issue or a self-correction, the three decision exits with `readCheckpoint`, the round limit without "p", the guards, stops before the work review |
| `test/helpers.ts` | `ScriptedUi`, `ScriptedPlanner`, `ScriptedReviewer` (the services, scripted), `testLayer`, `testWiring`, temporary git repository |
| `test/fakeSdk.ts` | A fake of the two SDKs for the adapter tests |
| `test/*.property.test.ts` | Property-based tests with `fast-check`, for the rows of the table in `docs/functional-design-review.md`, recommendation E |
| `docs/effect-v4-api.md` | The API ledger: every Effect name used, with its declaration and the facts observed about it |
| `prototypes/` | The SDK prototypes and the schema acceptance prototype used to verify the environment; not part of the program |
| `.githooks/pre-commit` | Type check before each commit; not part of the program |
| `.github/workflows/ci.yml` | The gate of the release route: on a push to `main` or a pull request, `npm test` on ubuntu-24.04 (Node from `.node-version`, Playwright's Chromium, bats, Ruby and bashly at the image's versions); after a green `main`, the `release` job fast-forwards `release` with the deploy key `RELEASE_DEPLOY_KEY`. Untested wiring, like `src/main.ts`; `test/ci.test.ts` checks that its versions match this machine's tools |
| `container/Dockerfile` | The image of the development container, built by `compose.cc.yaml` as `claude-code-base`: Claude Code, and the tools the suite needs that npm does not provide — Playwright's Chromium, Ruby and bashly (which generates `bin/ilcli`) and bats (which tests it), each pinned by an `ARG` and checked against this machine and the workflow by `test/ci.test.ts`. Moved into the repository on 27 Sep 2026 from a sibling directory outside it; not part of the program |
| `.node-version`, `.npmrc` | The container's exact Node version, which CI uses; `engine-strict=true`, so that `npm ci` refuses a Node outside `engines` (`>=22.18`) |
| `bin/ilcli` | The developer's command on the host, generated by bashly and committed (the host has no bashly); not part of the program. The docker commands of the development container (`run`, the default, `shell`, `review`, `build`, `down`, with their arguments passed as `bin/dev-claude` passed them, except that `--help`/`-h` after `shell`, `build` and `down` show their usage instead of running docker, by the developer's decision of 27 Sep 2026), `release` (push `main`) and `upgrade` (the installed copy to `origin/release`, then `npm ci` and `npm run build`); `help` documents every command |
| `bin/ilcli.bashly/` | Its source: `bashly.yml` (the commands and the usage text), `settings.yml`, one `<command>_command.sh` per command, `initialize.sh` (`--version`/`-v` to claude; the arguments kept as typed), `lib/common.sh`, `header.sh`, `bashly-strings.yml` |
| `test/cli/*.bats` | The tests of `bin/ilcli` with bats: the usage, the docker commands' argument vectors, `release` and `upgrade` over temporary repositories, and that the committed script is what bashly generates |

## Behaviour that is decided and must not change without the developer's instruction

1. The program waits for the user only where a decision is required. No confirmation prompts elsewhere.
2. Question phase before planning phase 1: Claude Code proposes a question list (question, reason, proposed answers, default); Codex reviews it; the interview takes place in the orchestrator's terminal or in the web page, whichever Ui runs; follow-up questions are unrestricted; Claude Code proposes the end with a summary and the user confirms; Codex reviews `requirements.md` for gaps, and accepted gaps lead to a second interview; an empty agreed list still offers the conversation.
3. Planning calls: Claude Code may write only under `plan-review/`. A `PreToolUse` hook denies other edits before they occur; the project snapshot comparison after each call is the second check.
4. Execution phases use `permissionMode: "auto"`. A call to `AskUserQuestion` is a stop: the answer is recorded, a hook then denies every tool except `StructuredOutput`, the turn ends, and the plan is always revised and reviewed before the next execution phase.
5. Codex runs with `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`, because bubblewrap cannot start in the containers. The program halts if the project or the reviewed file changed during a Codex turn. Codex keeps one thread per review loop.
6. Five dispositions (`accepted`, `partially_accepted`, `rejected`, `no_change_needed`, `clarification_requested`), self-corrections, and reviewer feedback. Every rationale is returned to Codex through the issue log.
7. Pause conditions in `reviewLoop`: repeated issue that was not accepted in full (same id, or new id reported through `duplicate_of`); reversal of an accepted correction; disputed self-correction; second clarification request for one id; identical file content to an earlier round; unexplained change; `maxIdleRounds` rounds without an accepted issue; round limit (`maxRounds`). Three policies of a subject (`src/reviewState.ts`): `proceed` (the "p" choice at the round limit, none for the work review), `leaveOnAcceptance` (a round with a correction due — an accepted or partially accepted disposition, or an effective self-correction `accepted` or `plan_error` — ends the loop with `revise` right after its log and the `logged` checkpoint), and `leaveOnDecision` (a non-empty decision at any pause ends the loop with `revise` instead of a planning call; the round, the decision's log entry and the checkpoint are written as far as the step allows, and every checkpoint written is one `readCheckpoint` accepts). Only the work review sets the last two.
8. Records, all under `<project>/plan-review/`:
   - `conversation.md` — the run in readable form, in order.
   - Per round of a review loop, in the loop's own subdirectory: `review-<n>.json` and `cc-<n>.json`, the agents' raw replies, and `round-<n>.json`, the program's validated record of the round (`no_response` after the review, `validated` after the response).
   - The five issue logs, each `{ version: 2, entries }` with entries tagged by `source`: `questions-log.json`, `requirements-log.json`, `issue-log.json`, `work-review-log.json`, and `decision-log.json` (decision support, by the developer's instruction of 28 Sep 2026), which holds the entries of every decision of the run; decision k reads and replaces only the entries whose ids begin with `D<k>-`.
   - `usage.jsonl` — one per-agent record per line.
   - `questions.json` — the agreed question list.
   - `baseline.json` — the tree of the project at the start of the run, built in a temporary index.
   - `work-review-<k>/changes.diff` — the diff from that tree to the current one, rewritten before every round of work review k.
   - `decision-<k>/` — decision k of the run (decisions are numbered across the run, and a decision may contain decisions): `question.json` (the question, its options and the phase in which it was asked), `cc-0.json` (the analysis call's raw output), `analysis.json` (the validated analysis, the reviewed file), the round files of its review loop, and `chosen.json` (the user's answer after the analysis and the option it chose).
   - `invalid-replies/` — agent replies that did not match their schema.
   - `checkpoint.json` — `{ version: 2, subject, phase, round, stage, time }`, replaced after all records of a transition are written, so that it identifies the last committed transition (decision Q6; no resume).

   Record files carry `version: 2`, and only that shape is read: the records of runs before 25 Sep 2026 (a bare array as a log, per-SDK usage lines, no version marker) are not readable by this program (decision Q5, narrowed by the developer the same day). JSON records are written to a temporary name and renamed into place. A new run moves the previous run to `plan-review/archive-<time>/` (a second run in the same clock instant gets a `-2` suffix).
9. Configuration precedence: defaults in `src/schema.ts`, then `config.json` in this repository (all projects), then `<project>/plan-review/config.json`. Invalid JSON, a wrong type or an unknown key in either file stops the program before any agent call and before the records are initialised (decision Q4 of the Effect rewrite).
10. Validation of agent replies (decision Q5): a structured reply of a planning, interview or review call that does not match its schema is kept in `invalid-replies/`, and the agent gets one repair turn in the same session or thread; a second mismatch stops the run. Execution reports get no repair turn: a recorded `AskUserQuestion` stop takes precedence, and an invalid report without a stop is treated like a missing one (status `aborted`).
11. Interruption (decision Q3): Ctrl+C in the terminal, or Stop task in the web page, aborts both SDK calls, closes the terminal interface, prints `INTERRUPTED by the user. State is preserved in …`, appends `**Interrupted by the user.**` to `conversation.md`, prints the Claude Code session id and the usage summary, and exits with code 130 (in the page: the run ends with code 130 and the server keeps running; Ctrl+C in the server's terminal tells every tab that the server is ending and closes its connection, so the server ends at once). A halt exits with 1, a missing task with 2.
12. The work review (the web GUI task, 26 Sep 2026): after every execution phase, whatever its status (a stop's input is recorded first), Codex reviews `work-review-<k>/changes.diff` and the project against `plan.md` and `requirements.md`, in rounds under behaviours 5, 6, 7 and 10, in its own thread, log (`work-review-log.json`) and subject directory (`work-review-<k>/`), ids `W<k>-R<n>-<i>`. Claude Code answers under a read-only capability (stage A of `docs/gui-review.md`, finding 1): a `PreToolUse` hook without a matcher denies every tool but the structured output, the repair turn included; the review, the phase's entries of the work-review log and `changes.diff` are in the prompt; a change of the project during the response halts the run with `ProjectChanged`, as for any planning call (behaviour 3), and a change of a guarded record under `plan-review/` (all but `usage.jsonl`, `invalid-replies/` and the archives) halts it with `RecordsChanged`. A correction due or any user decision at a pause leads to the next planning phase (the plan is revised from the round record, the log and `user-decisions.md`, reviewed, executed, and reviewed again); the round limit offers no "p". The run is finished only when the execution reported `finished` and its work review converged. The guard of behaviour 5 compares, besides the project, the recomputed diff and the bytes of `changes.diff`.
13. Decision support ("Help me Decide", by the developer's instruction of 28 Sep 2026; the design is `docs/decision-support-design.md`). **`docs/decision-making.md` is the authority for the content and layout of every representation of the arguments for and against the options of a decision: no program text, prompt or agent may contradict it, and the prompts of a decision carry its text verbatim after the sentence `DECISION_FORMAT_AUTHORITY` of `src/prompts.ts`.** Every prompt that offers two or more options carries one offer per question, never one per option: the page shows a "Help me Decide" button, and the terminal a line naming the command `/decide` (`src/offer.ts`). They are the interview's numbered answers, a question Claude Code relays with options, a permission request (Allow, Deny), a disputed pause of behavior 7 (a repeated issue not accepted in full, the reversal of an accepted correction, a disputed self-correction, a second clarification request: the reviewer's and the planner's positions), a question of Claude Code at a pause or from the plan writer that has options (`questions_for_user` is a list of `{ question, options }`), and the cycle limit (Proceed where offered, Stop, more cycles, the count entered after choosing); not the single-action prompts (Confirm the summary, Start planning), and Quit is no option. Taking the offer runs a decision loop inside the current phase, not a phase of its own: Claude Code produces the analysis (`DecisionAnalysis`) in a fresh session with the task, `requirements.md`, `plan.md` and the question in its prompt, as a planning call (behavior 3); the program validates it (one column per option, unique ids, a recommendation naming an option) and writes `decision-<k>/analysis.json`; Codex reviews it in rounds under behaviors 5, 6, 7 and 10, ids `D<k>-R<n>-<i>`, the cycle limit unchanged (0 halts with `RoundLimitStop`). Decisions are numbered across the run, a decision may contain decisions, and the checkpoint names `decision-<k>` with the enclosing phase. The analysis is shown (the page over both chat columns until the question is answered; the terminal one option after another), the question is asked again, and the answer is recorded in `decision-<k>/chosen.json` with a note in `conversation.md`; it reaches `user-decisions.md` only where that prompt writes there anyway. The phases of a run and the progress panel do not change.

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

Command-line behaviour follows the Command Line Interface Guidelines (clig.dev): the terminal
interface of the program (`src/main.ts`, `src/ui.ts`) and the developer's command `bin/ilcli`. It
governs the command line only — the page answers to the heuristics and to Material Design above, and
the program's internals to the Programming principles. Several of its points are already decided
behaviour and stay as they are: configuration precedence (behaviour 9), the exit codes (behaviour 11:
130 interrupted, 1 halted, 2 a missing task), and prompting the user only where a decision is
required (behaviour 1). Where it adds something, it is the standard a command-line decision is argued
from, as the heuristics are for the interfaces.

## Facts established by runs in the developer's containers

Dates: 21 Sep 2026 (SDKs), 24 Sep 2026 (Effect), 26 Sep 2026 (the web GUI and the work review).

- Agent SDK 0.3.283 (bundles Claude Code 2.1.283; upgraded from 0.3.278 on 26 Sep 2026 because Opus 5.5 requires Claude Code 2.1.280 or newer — the SDK's bundled Claude Code, not the container's `claude`, is what a run uses) uses the container's existing login; no API key. The prototype `prototypes/proto.ts` passed on 0.3.283 (26 Sep 2026: login credentials, hook denial, `AskUserQuestion` and permission requests in `canUseTool`); the real run of the upgrade procedure is the next run.
- `AskUserQuestion` reaches `canUseTool` under `auto` mode. Resuming one session with a different permission mode per call works.
- Structured output is delivered through a tool named `StructuredOutput`; a hook that denies all tools also denies the final report.
- Codex SDK 0.155.1: one thread keeps context across turns, and each turn accepts its own `outputSchema`. Established with `thread.run`. The adapter now uses `thread.runStreamed`, under which four real turns (26 Sep 2026) each accepted their `outputSchema` and decoded, but every one was the first turn of its own thread, so the context half of the fact is not re-established; see "Not yet known".
- Claude Code writes to its state file on every call. In the developer's projects that file is `.devcontainer/claude.json`, a tracked file inside the project, so `config.json` lists it under `ignorePaths`.
- Effect 4.0.0-rc.117 and `@effect/platform-node` 4.0.0-rc.117. Both agents accept the JSON Schema that `Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` generates from the seven agent schemas: `prototypes/proto-schema.ts` made 28 calls (7 schemas × raw/strict × Codex/Agent SDK), all accepted and all replies decoded; the raw and strict variants were byte-identical. The program sends the raw variant (`prototypes/proto-schema-output/CHOSEN`); the strict transform stays as a tested fallback.
- `NodeRuntime.runMain` interrupts the main fiber on SIGINT or SIGTERM and then calls the teardown, which sets the exit code (read in the runner's implementation, `@effect/platform-node-shared/dist/NodeRuntime.js`). In terminal mode readline receives Ctrl+C itself; `src/ui.ts` passes it on as a real SIGINT.
- 25 Sep 2026, first real run after the Effect rewrite (a documentation task on a scratch project, in the development container, which has both agents' credentials and the installed program at `/opt/interloq`): question phase with an empty agreed list, one planning phase, Codex convergence in round 1, one execution phase, `finished`; three Claude Code calls, two Codex turns; no agent process left running.
- `total_cost_usd` of the Agent SDK's result message is the running total of the session, and a resumed session continues from its saved total (the SDK's own description, confirmed in that run: 0.49, 1.06, 1.77 across the three calls of one session). `usage.jsonl` keeps the value of each call; the usage summary reports each session's last value.
- The project snapshot (decision Q1 of the functional design review, 25 Sep 2026): `git status --porcelain=v2 -z --untracked-files=all`, every listed path with its record and its working-tree entry — a regular file's content hash, a symbolic link's target (the link itself), a directory, or missing. It detects edits of untracked files, staged replacements, renames and retargeted links; gitignored files are unobserved. `plan-review/` and `ignorePaths` are excluded by one predicate.
- 25 Sep 2026, the interruption check (plan step 6.3, three runs in the development container): Ctrl+C at the `Enter = start planning` prompt, during a Codex review, and during the Claude Code planning call each ended with `INTERRUPTED by the user. State is preserved in …`, the session id and usage lines, `**Interrupted by the user.**` in `conversation.md`, exit code 130, and no `claude` or `codex` process left running. An aborted Codex turn or Claude Code call leaves no `usage.jsonl` line, because usage is recorded only from a completed result.
- 26 Sep 2026, the first real runs of the web GUI and the work review: four runs in the development
  container on a scratch git project, Claude Code Opus 5.5 and Codex `gpt-6-astra`, the question phase off.
  The work review runs after the execution phase, in a thread of its own, and writes `work-review-1/` with
  `changes.diff`, `review-1.json` and `round-1.json`, an empty `work-review-log.json` when no issue is
  raised, and the checkpoint `work-review-1` / round 1 / `reviewed`. Both complete runs converged in round 1
  with no issue. `changes.diff` was 725 bytes for a two-file task and 3,844 bytes for a small command-line
  tool; the work review's Codex turn cost 62,718 and 70,547 input tokens against the plan review's 61,688
  and 82,789, so the diff is negligible beside the context Codex builds from the repository, and a work
  review costs about what a plan review costs.
- 26 Sep 2026, the page: served from the container on the published port 8090 and opened from the host's
  browser, with the start form pre-filled from the server's working directory, the two panels, the progress
  rail, the model lines and the activity line. Two windows on the same address showed one run alike and
  either could act on it. Stop in the window that had not started the task ended it in both, twice: during a
  Codex review it left `plan.md` and `planning-1/cc-0.json` written, no `review-1.json`, a Claude line in
  `usage.jsonl` and no Codex line; during the Claude Code planning call it left no plan, no `planning-1/`
  and no `usage.jsonl`, and the usage summary read 0 calls although the session id was already known from
  the init message. Both left the checkpoint at `run` / `started` and `**Interrupted by the user.**` in
  `conversation.md`, and the server stayed up: the next task started from the page and archived the
  previous run's records. So an aborted call of either SDK records no usage, as the terminal check of
  25 Sep found.

- 26 Sep 2026, the replay capacity (finding 13 of `docs/gui-review.md`, decision Q4; `test/replayCapacity.test.ts`,
  scripted, in the development container): a run of 10,030 events (tool activity, program lines, one review with
  three issues in ten) retained about 4 MB, took about 230 ms to publish in full, copying of the run's event array
  included, and its replay (1.55 MB of JSON) reached one client in 45–51 ms. The criterion of Q4 (a replay over 1 s,
  or more than 50 MB retained) is not approached, so chunked transcript storage was not built; the criterion is the
  test's regression bound. Since 27 Sep 2026 the bound applies to the best of five replays, so that it holds on a loaded machine (a shared CI runner): a regression slows every sample, a burst of load only some.

## Not yet known or not yet built

- The exchange between the agents has run for real once (25 Sep 2026, the plan for the functional design review: 6, 4 and 1 issues in three rounds, all accepted); rejections, clarifications, the pause conditions and the repair turn have run only in scripted tests. That run also showed Codex's turns growing with the thread (147k to 1.35M input tokens over seven turns) until its usage limit halted the run.
- Decision support has not run for real. A decision taken at a permission request holds the execution call open while the decision loop runs; if Claude Code changes the project concurrently in that call, the decision loop's guards halt the run with `ProjectChanged` (behaviors 3 and 5 are not relaxed). The analyses of requirements gathering will be dense with "unknown", which `docs/decision-making.md` requires; the developer wants to see one before judging its use.
- Resuming an interrupted run is not implemented. The developer wants it later; `plan-review/checkpoint.json` identifies the last committed transition, and `readCheckpoint` in `src/records.ts` verifies that the records it names exist and decode.
- Whether `runStreamed` keeps a Codex thread's context across the turns of one review loop is not
  established. Four real loops on 26 Sep 2026 (two plan reviews, two work reviews) each converged in round 1,
  so no thread ever took a second turn; the adapter holds one thread per loop by construction
  (`src/codex.ts`), and the four turns carried four distinct thread ids, one per loop, as intended. The
  question needs a review loop that runs two rounds, which needs Codex to raise an issue, and it raised none
  on small greenfield tasks with `countMinor` already true. The same run would settle the remaining half of
  the `outputSchema` fact above.
- The release route has not run for real: the workflow on GitHub Actions (both jobs, the Playwright
  install, the push with the deploy key), the ruleset on `release`, and `bin/ilcli`'s docker commands,
  `release` and `upgrade` on the host were written in the container, which has no docker, no `~/work`
  and no access to GitHub Actions. `test/cli/*.bats` runs `release` and `upgrade` over temporary
  repositories with docker and npm stubbed. The developer's first release settles the rest. The test
  suite was made to pass on a machine at load 20–30 (27 Sep 2026); whether that holds on a shared
  runner is also settled by the first run.
- The interview turn's schema with `asked_ids` (issue #21, 27 Sep 2026) is not proven by the prototype. Its two files in `prototypes/proto-schema-output/` (`interviewTurn.raw.json`, `interviewTurn.strict.json`) were regenerated from `src/schema.ts` in the container, not written by an accepted run, so the fact above about the seven agent schemas does not yet cover this one. The proof is the developer's run of `node prototypes/proto-schema.ts <project> --only=:interviewTurn` in a project container.
- The schemas of decision support are not yet proved by the schema acceptance prototype. The changed `plannerResponse`, `planWrite` and `questionListResponse` files in `prototypes/proto-schema-output/` (structured `questions_for_user`, 28 Sep 2026) were regenerated from `src/schema.ts` in the container, not written by an accepted run; the recursive `DecisionAnalysis` has the shape that `prototypes/proto-recursive-schema.ts` proved, but not its exact fields. The proof is the developer's run of `prototypes/proto-schema.ts` in a project container.
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
- An upgrade reaches real runs by the route under Rules for changes: `bin/ilcli release`, the checks
  on GitHub, `release` advanced, then `bin/ilcli upgrade` in `~/work/interloq` (which always runs
  `npm ci` and `npm run build`).

## Rules for changes

- Test first, without exception. Before application code is written or changed, the test that specifies it is written, run, and seen to fail for the reason the change is meant to fix (a failed assertion, or a type error naming the signature being changed; never a missing module or a typo). Then the least code that makes it pass. A new module may first be scaffolded with its final signature and a body that does nothing useful, so that the test fails on its assertion. The observed failure is recorded in the commit message.
- Every change to behaviour gets a scenario test in `test/` that runs the procedure against the test layers of `test/helpers.ts` (`testLayer`, `testWiring`). `src/issueLog.ts` stays free of I/O and of Effect services so that it can be tested directly.
- `src/claude.ts` and `src/codex.ts` receive the SDKs through the `Sdk` service and are tested with `test/fakeSdk.ts`. Only `src/sdkLive.ts` (the binding), `src/main.ts` and `src/web.ts` (the wirings and the runner) are untested; their text is shown to the developer before it is written. No scaffolding may reach a real agent: a scaffold of an adapter makes the SDK call impossible. Verify SDK option names against the type declarations in `node_modules`, not from memory.
- Do not add a dependency without the developer's instruction. Permitted besides the two SDKs: `effect`, `@effect/platform-node`, and these devDependencies, each pinned exactly and checked by `test/deps.test.ts`: `fast-check` (property tests); for the web GUI (instructed 26 Sep 2026) `svelte` (the page), `vite` and `@sveltejs/vite-plugin-svelte` (the build), `vitest` (component tests), `jsdom` (the DOM for Vitest), `svelte-check` (type check of `.svelte` files), `@playwright/test` (end-to-end tests), `marked` and `dompurify` (Markdown rendering and sanitising in the page), `m3-svelte` (Material Design 3 components) and `vite-plugin-functions-mixins` (the CSS `@function`/`@mixin` of m3-svelte's components, resolved at build time). Outside npm, two tools of the container image, neither an npm dependency: bashly (generates `bin/ilcli`) and bats (its tests; permitted on the developer's instruction, 27 Sep 2026; meant to come from the image, installed by hand until then).
- This directory is the development clone. The installed program is `~/work/interloq` on the host, which project containers mount read-only at `/opt/interloq`, and it tracks the branch `release` of github.com/mackler/interloq, not `main`. A change reaches real runs by one route: the developer runs `bin/ilcli release` (pushes `main`); the workflow `.github/workflows/ci.yml` runs `npm test` on GitHub; only if it passes does its `release` job fast-forward `release` to that commit (with a deploy key, the only identity a ruleset lets update `release`); then `bin/ilcli upgrade` on the host brings the installed copy to `origin/release` and runs `npm ci` and `npm run build`. So the installed copy can only ever pull a commit whose suite has passed — the point of the route. Nothing in this container can push, reach GitHub Actions, or touch `~/work`; the developer does those steps.
- `bin/ilcli` starts the development container (`compose.cc.yaml`) and carries a change to the installed copy (`release`, `upgrade`); it is not part of the program. It is generated by bashly from `bin/ilcli.bashly/` and tested by `test/cli/*.bats`.

## Credentials in the development container

`CLAUDE_CODE_OAUTH_TOKEN` is Claude Code's login, and Codex's credentials come from the `~/.codex`
volume; both are needed for a run. `INTERLOQ_ISSUES_TOKEN`, added 27 Sep 2026, is optional and is
**not** used by the program: it is a fine-grained GitHub token limited to this repository with Issues
read and write, which lets the assistant working in the container file an issue with the REST API.
Reading issues needs no token, because the repository is public. Nothing in `src/` may read any of
these, and no prompt, record or log may contain one; every process in the container can read the
environment, so the token's scope is the safeguard, not its secrecy.

## Further context

`docs/history.md` records how the program came to its present form and what was tried and rejected. Read it before proposing a change to the architecture or to the container arrangement.
