# Response to the GUI and work-review review (docs/gui-review.md)

## Context

Codex reviewed commits `ec6a1d4..364158b`, the web GUI and the work review, and reported 14 findings
in `docs/gui-review.md` (uncommitted at the time of writing). The review verified rather than
inferred: it ran the suite, built probes in temporary repositories, and drove the built page in
Chromium. Three claims were checked independently before this plan was written and all three held:
finding 1 (a work response may write anywhere under `plan-review/`), finding 2 (`decodeURIComponent`
bare inside a handler whose error channel is `never`), and finding 9 (an exclusion property whose
oracle is literally the implementation, so it cannot fail).

This plan is the disposition of all 14 findings and the work that follows from it. It is not yet
approved; two decisions are marked for the developer.

## Dispositions

| # | Sev. | Disposition |
|---|---|---|
| 1 | High | **Accept.** Verified. Behaviour 12's "answers without changing any file" is prompt text only: the work subject's `respond` goes through `planningCall`, so the planning hook permits writes under `plan-review/`, and the snapshot excludes that directory. |
| 2 | Med | **Accept.** Verified. `decodeURIComponent(url.pathname)` and `new URL(request.url, …)` in `src/webServer.ts` can throw; the handler advertises `never`. |
| 3 | Med | **Accept.** `localStorage` read and write in `StartForm.svelte` are unguarded; a throwing write blocks Start. |
| 4 | Med | **Accept.** `git rev-parse --git-dir` accepts a subdirectory; the baseline builder then fails on `--pathspec-from-file` with pathspec arguments. The validator and the builder disagree about what a project is. |
| 5 | Med | **Accept.** The draft in `PromptWidget.svelte` is cleared only by its own send, so another tab's answer leaves it attached to the next prompt. Directly against the multi-tab requirement. |
| 6 | Med | **Accept.** Enter submits while an input method is composing. |
| 7 | Med | **Developer's decision (D1).** Not a defect against the agreed scope, which was a desktop browser on the host; it is a fair call against the Material Design commitment in CLAUDE.md. Either adapt the layout or record the limit. |
| 8 | Low | **Accept.** The interview's opening `say` teaches the terminal's `"""` convention, which the page does not implement. |
| 9 | Med | **Accept, and sharpen.** The exclusion property is vacuous and should be deleted outright, not weakened: a test that cannot fail is worse than none, because it occupies a row in the recommendation-E table. The driver's round mismatch and the unproven "ends at the first correction due" law are separate and also accepted. |
| 10 | Med | **Accept.** The four end-to-end scenarios passed while findings 3, 5, 6 and 7 were present. |
| 11 | High | **Accept as a defect, keep the review's own caveat.** Reproduced only with deliberately blocking probes, not in ordinary use; the remedy stands regardless. |
| 12 | High | **Accept, re-rate Medium.** The scenario needs a server restart, a queued Stop and a second tab racing it, on a single-user local tool. The fix is cheap, so rating it down costs nothing. |
| 13 | Med | **Accept in part, defer the rest.** Cap the per-tab forwarding queue now; chunked transcript storage waits until a long run is measured, as the finding itself advises. |
| 14 | Low | **Accept.** `DOMPurify.addHook` mutates an imported singleton at module load. |

## A fifteenth finding, found by the developer (26 Sep 2026)

15. **Medium — the web server cannot be stopped while a browser tab is connected.** `src/web.ts`.
    Ctrl+C in the server's terminal does not return while any tab holds its WebSocket: Node's
    `http.Server.close()` waits for existing connections instead of destroying them, and a WebSocket
    never ends by itself. Observed after an hour's idle server with one window open on the page; one
    established connection to port 8090 remained, and the process had to be killed. **Remedy:** on
    interruption, close the open sockets as part of the server's finalizer, after telling each tab
    the server is going down so the page can say so rather than merely losing its connection. Test
    that a scripted client connection does not prevent the server effect from completing when it is
    interrupted. Contrast with Stop, which ends a task and leaves the server up: this is the
    deliberate end of the server itself, and behaviour 11's promise of a clean interruption should
    hold for it too.

## Sequencing, and why finding 1 comes first

The obvious route is to hand this to plan-review itself, as with the functional design review, so that
the new work review checks the result. That route is unsound until finding 1 is fixed: a work-review
response can today rewrite `plan.md`, so the phase meant to police the work can silently rewrite the
plan the work is judged against. **Fix finding 1 by hand, test first, and commit it before any run of
the program on this repository.** Everything after that can go through plan-review normally.

## Work

- **Stage A, by hand: read-only work responses (1).** A call capability for work responses that denies
  every editing tool through a `PreToolUse` hook, applied to the repair turn as well; after the call,
  compare the record files (`plan.md`, `requirements.md`, the logs, `changes.diff`) as well as the
  project, and halt with a typed error if any moved. Adapter tests that attempt each edit, and a
  procedure test that a work response replacing `plan.md` halts the run. Touches `src/claude.ts`
  (a second hook and a capability on the planning call), `src/review.ts`, `src/subjects.ts`,
  `src/services.ts`, `src/errors.ts`.
- **Stage B: typed edges (2, 3, 14).** A `Result`-returning decode of the request target in
  `src/webServer.ts` with a deliberate 400; a small tested storage edge in the page; a privately
  constructed sanitizer in `web/src/markdown.ts`.
- **Stage C: identity and lifecycle (4, 11, 12).** Require the worktree root in `src/runManager.ts`
  with an explanation the page can show; make each ownership transfer in the manager
  cancellation-safe, with interruption-injection tests at every transition; add a server incarnation
  to run and prompt identity in `src/protocol.ts` and discard actions from an earlier incarnation
  with a notice.
- **Stage D: page input and help (5, 6, 8).** Scope the draft to `(run, prompt)` and withdraw it when
  that prompt is answered elsewhere; ignore composing Enter and add a visible Send; move the
  interview's opening help into a structured Ui event with terminal and page renderings.
- **Stage E: verification (9, 10, 13).** Delete the vacuous exclusion property and replace it with an
  independent path policy; fix the property driver's script selection and assert the first-exit law
  directly; add the browser scenarios the review names (an interview to confirmation, a work
  correction through a second planning and execution phase, two tabs with an unsent draft, a dropped
  socket with replay, a long transcript), and fail on uncaught page errors; cap the forwarding queue.
- **Stage F (only if D1 says in scope): adaptive layout (7).**
- **Final stage: a Disposition section appended to `docs/gui-review.md`**, one line per finding with
  its outcome and commit, as was done for `docs/functional-design-review.md`.

## Refinements after Codex's critique of this plan (26 Sep 2026), all accepted

1. **The read-only contract of stage A must be a capability, not a list of tool names.** Denying
   `Write`, `Edit`, `MultiEdit` and `NotebookEdit` leaves `Bash` able to write any file. The hook
   denies every tool except the structured output, as the post-stop hook of behaviour 4 already does.
   The protected set is every record of `src/artifacts.ts`, including `baseline.json`,
   `checkpoint.json` and earlier round records, not only the four named earlier. The guard must not
   trip on the orchestrator's own writes during the call: `usage.jsonl` and `invalid-replies/` are
   written by the program, and the invalid-reply file precedes a repair turn. Hook-prevention tests
   and detection tests are separate: the latter bypass the hook deliberately.
2. **Committing stage A here is not the handoff.** The run uses `/opt/plan-review`, a read-only mount
   of `~/work/plan-review`, so stage A reaches a run only after `git pull` and `npm ci` there. And
   stage A does not make everything else safe: the lifecycle defects of findings 11 and 12 are in the
   page's Start and Answer paths, so the terminal is the sound interface until stage C is committed
   and installed.
3. **Stage C covers `src/webUi.ts:61` as well as the manager.** The lost-answer transition is there.
   Tests at each transition: reservation, event publication, deferred completion, connection
   cancellation. Slow subscriber delivery stays outside the protected region. The draft identity of
   stage D includes the incarnation that stage C introduces.
4. **"Cap the queue" is underspecified.** A bounded queue that blocks lets one slow tab stall the run;
   dropping events breaks the transcript the protocol promises. The behaviour is: disconnect the slow
   subscriber, release its resources, and let it recover by replay. Stage E measures event volume,
   replay time and copying on a long scripted run; that measurement, not a scrolling test, is what
   decides whether chunked storage is needed.
5. **D1 is a request for a scope exception, and my earlier wording was wrong.** No minimum window
   width was ever agreed; "the host's browser" says where the browser runs, not how wide it is. So
   finding 7 is a defect against the Material Design and Nielsen commitments in CLAUDE.md unless the
   developer accepts the limitation explicitly. The default is adaptive layout keeping the panels
   side by side wherever they fit.
6. **Finding 12 keeps its High rating.** The review rated severity by impact, and interrupting an
   unrelated task is a high-impact outcome; rarity belongs to priority, not severity. The rationale
   and the tests cover stale answers as well as a stale Stop.
7. **Finding 9, stated precisely.** The exclusion property is not incapable of failing: it detects a
   divergence between `excludedIndexPaths` and `excluded`. It cannot test the policy those two share,
   which is what the recommendation-E row claims. It is replaced by an independent path policy, and
   the first-exit, command-order and pause-precedence assertions of the other properties are kept.

## Decisions for the developer

- **D1, finding 7.** Is a usable page below roughly 900 pixels a requirement, or is the desktop window
  the agreed scope with the limit recorded in CLAUDE.md?
- **D2, route.** After stage A is committed by hand, does the rest go through plan-review as one task
  in stages, or by hand here? Through the program is the better test of the program; by hand is
  cheaper and faster.

## The task text

Before the run: copy this file to `docs/gui-review-response.md`, and commit it with
`docs/gui-review.md`, so both are inside the project the run reads.

```
Apply docs/gui-review.md, Codex's review of the web GUI and the work review (14 findings with file
and line, separated into confirmed defects, conditional risks and design tradeoffs), to this program,
in stages. docs/gui-review-response.md is the agreed disposition of every finding and the agreed
shape of the work: it is settled, and the question phase does not re-open it; where it and the review
disagree, the response document governs, and where it leaves something open, ask. Read CLAUDE.md
first and follow all of its rules: test first without exception, every Effect name looked up in
docs/effect-v4-api.md or the installed declarations, the twelve decided behaviours unchanged except
where the response document says otherwise, erasable syntax only, the programming principles, prompts
only in src/prompts.ts, the User interface section, no new dependency, and each stage ending with npm
test green and committed on its own with the observed failures in the commit message. Stage A first
and alone in its own commit: work-review responses become read-only, enforced by a capability rather
than a list of tool names, because a work response can today write any file under plan-review/ and so
rewrite the plan it is judged against. Note while you work that the orchestrator running this task is
the installed copy at /opt/plan-review, which does not contain stage A, so this run is not itself
protected by it; do not rely on the work review to catch a change to plan-review/ during this run.
Then the remaining stages in the order of the response document: typed edges, identity and lifecycle,
page input and help, verification, and the adaptive layout of finding 7. The verification stage
deletes the vacuous exclusion property rather than weakening it, fixes the property driver's script
selection, asserts the first-exit law directly, and adds the browser scenarios the review names,
failing on uncaught page errors. The last stage appends a Disposition section to docs/gui-review.md
listing every finding with its outcome and commit, without changing the findings' text, as
docs/functional-design-review.md has. Where a finding's remedy conflicts with a decided behaviour or
with the response document, stop and ask.
```

If you would rather record the narrow-window limitation than fix it, strike "and the adaptive layout
of finding 7" from that paragraph and say instead that finding 7 is accepted as a limitation to be
recorded in CLAUDE.md's User interface section.

## Verification

`npm test` green at every stage (392 unit, 29 web, 4 end-to-end today, more after stage E). For stage
A specifically: a scripted work response that writes `plan.md` must halt the run with a typed error,
and the same attempt must be denied at the hook before it reaches disk. After the last stage, one real
run through the work review in the terminal and one in the page, as step 6.3 did, to confirm nothing
regressed in the paths only real agents exercise.
