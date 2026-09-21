# plan-review

A TypeScript program ("the orchestrator") that runs Claude Code and Codex against one project.
Claude Code writes a plan, Codex reviews it in rounds until a review contains no counted issue,
Claude Code implements the plan, and every stop during implementation leads to a plan revision
and a new review before work continues. The orchestrator contains no model calls of its own; it
starts both agents through their SDKs, passes text between them, keeps the records, and asks the
user for a decision at defined points.

## Commands

- `npm run check` — type check (`tsc --noEmit`). Must report nothing before every commit; `.githooks/pre-commit` runs it and refuses the commit otherwise. Enable the hook once per clone with `git config core.hooksPath .githooks`.
- `npm test` — type check, then scenario tests with scripted agents (`node --test test/*.test.ts`). A type error fails the tests before any test runs. No credentials needed; requires `git`.
- Real run, inside a project container that has both agents' credentials and network access:
  `node /opt/plan-review/src/main.ts "task description" [project directory]`

There is no build step. Node.js (22.18 or later) runs the `.ts` files directly by removing the types.

## TypeScript constraints (required by direct execution)

- Erasable syntax only: no `enum`, no parameter properties, no namespaces with runtime code (`erasableSyntaxOnly` enforces this).
- Type-only imports use `import type` (or inline `type`); Node.js does not remove unused value imports.
- Relative imports carry the `.ts` extension.
- Node.js does not type check. `npm run check` is the only type check.

## Layout

| File | Content |
|---|---|
| `src/main.ts` | Entry point: arguments, configuration, halt handling, usage summary |
| `src/run.ts` | Question phase, then alternation of planning phase K and execution phase K |
| `src/review.ts` | The review procedure (`reviewLoop`) with every pause condition; generic over a `Subject` |
| `src/subjects.ts` | The three subjects: question list, requirements, plan |
| `src/interview.ts` | Question phase and the interview in the terminal |
| `src/issueLog.ts` | Pure functions on the issue log (no I/O). Detection of repeated issues, supersession, user decisions |
| `src/claude.ts` | Claude Code through `@anthropic-ai/claude-agent-sdk` |
| `src/codex.ts` | Codex through `@openai/codex-sdk` |
| `src/prompts.ts` | Every prompt text. Prompts are not written anywhere else |
| `src/schemas.ts`, `src/types.ts` | JSON Schemas for structured output and the matching types; change both together |
| `src/state.ts` | Files in `<project>/plan-review/`, configuration, project snapshot for change detection, `Halt` |
| `src/ui.ts` | Terminal input and output behind the `Ui` interface |
| `src/agents.ts` | `Planner` and `Reviewer` interfaces, which the tests implement with scripted versions |
| `test/helpers.ts` | `ScriptedUi`, `ScriptedPlanner`, `ScriptedReviewer`, temporary git repository |
| `prototypes/` | The two SDK prototypes used to verify the environment; not part of the program |
| `.githooks/pre-commit` | Type check before each commit; not part of the program |

## Behaviour that is decided and must not change without the developer's instruction

1. The program waits for the user only where a decision is required. No confirmation prompts elsewhere.
2. Question phase before planning phase 1: Claude Code proposes a question list (question, reason, proposed answers, default); Codex reviews it; the interview takes place in the orchestrator's terminal; follow-up questions are unrestricted; Claude Code proposes the end with a summary and the user confirms; Codex reviews `requirements.md` for gaps, and accepted gaps lead to a second interview; an empty agreed list still offers the conversation.
3. Planning calls: Claude Code may write only under `plan-review/`. A `PreToolUse` hook denies other edits before they occur; the project snapshot comparison after each call is the second check.
4. Execution phases use `permissionMode: "auto"`. A call to `AskUserQuestion` is a stop: the answer is recorded, a hook then denies every tool except `StructuredOutput`, the turn ends, and the plan is always revised and reviewed before the next execution phase.
5. Codex runs with `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`, because bubblewrap cannot start in the containers. The program halts if the project or the reviewed file changed during a Codex turn. Codex keeps one thread per review loop.
6. Five dispositions (`accepted`, `partially_accepted`, `rejected`, `no_change_needed`, `clarification_requested`), self-corrections, and reviewer feedback. Every rationale is returned to Codex through the issue log.
7. Pause conditions in `reviewLoop`: repeated issue that was not accepted in full (same id, or new id reported through `duplicate_of`); reversal of an accepted correction; disputed self-correction; second clarification request for one id; identical file content to an earlier round; unexplained change; `maxIdleRounds` rounds without an accepted issue; round limit (`maxRounds`).
8. Records: `conversation.md` (readable, in order), JSON files per round, `usage.jsonl`. A new run moves the previous run to `plan-review/archive-<time>/`.
9. Configuration precedence: defaults in `src/types.ts`, then `config.json` in this repository (all projects), then `<project>/plan-review/config.json`.

## Facts established by runs in the developer's containers (21 Sep 2026)

- Agent SDK 0.3.278 (bundles Claude Code 2.1.278) uses the container's existing login; no API key.
- `AskUserQuestion` reaches `canUseTool` under `auto` mode. Resuming one session with a different permission mode per call works.
- Structured output is delivered through a tool named `StructuredOutput`; a hook that denies all tools also denies the final report.
- Codex SDK 0.155.1: one thread keeps context across turns, and each turn accepts its own `outputSchema`.
- Claude Code writes to its state file on every call. In the developer's projects that file is `.devcontainer/claude.json`, a tracked file inside the project, so `config.json` lists it under `ignorePaths`.

## Not yet known or not yet built

- Whether `total_cost_usd` is per call or cumulative per session. `usage.jsonl` records the values of each call.
- The exchange between the agents (rejections, clarifications, pauses) has run only in scripted tests, not against the real agents.
- Resuming an interrupted run is not implemented. The developer wants it later.
- Threads that the orchestrator starts are stored in the same `~/.codex` volume as the developer's interactive Codex sessions; the effect on `codex resume --last` is unverified.

## SDK versions

Both SDKs are pinned to exact versions, because the facts above were established on those versions
and each Agent SDK release bundles a new Claude Code. The developer wants the program to
stay current with both SDKs, which are released often, and does not want it to fall behind.

- At the start of every session in this repository, run `npm outdated` and tell the developer if
  either SDK has a newer version, before starting other work.
- Upgrade procedure: change the version in `package.json`, `npm install`, `npm test`, run the matching
  prototype in `prototypes/` in a project container, then one real run. Update the version numbers
  and any changed facts in the section above, and commit. The upgrade reaches real runs after
  `git pull` and `npm ci` in `~/work/plan-review`.

## Rules for changes

- Every change to behaviour gets a scenario test in `test/` that uses the scripted agents. `src/issueLog.ts` stays free of I/O so that it can be tested directly.
- `src/claude.ts` and `src/codex.ts` cannot be exercised without credentials. Keep them thin; put logic in modules that the scripted tests reach. Verify SDK option names against the type declarations in `node_modules`, not from memory.
- Do not add a dependency without the developer's instruction.
- This directory is the development clone. The installed program is `~/work/plan-review` on the host, which project containers mount read-only at `/opt/plan-review`. A change here takes effect in real runs only after the developer merges it there with `git pull`.
- `bin/dev-claude` starts the development container (`compose.cc.yaml`); it is not part of the program.

## Further context

`docs/history.md` records how the program came to its present form and what was tried and rejected. Read it before proposing a change to the architecture or to the container arrangement.
