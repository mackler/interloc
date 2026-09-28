# Decision support: design note

**Status: a proposal for the developer to check. Nothing here is decided behavior yet.**

This note describes a new part of the program: whenever the user must choose between options,
Interloq offers to work out the arguments for and against each one before the user chooses. The form
of that analysis is fixed by `docs/decision-making.md`, which is the authority for its content and
layout; this note covers everything else — where the offer appears, what happens when it is taken,
what is recorded, and how the result is shown.

## 1. The rule

Any time the user is given a choice between two or more options, the program must offer to help the
user make that choice.

There is no exception and no list of qualifying prompts to maintain: the rule is a property of the
prompt, namely that it offers more than one option. A prompt that offers a single action is not a
choice between options and carries no offer.

Applying the rule to the prompt catalog in `src/userPrompts.ts` as it stands today:

| Prompt | Options | Offer |
|---|---|---|
| A clarification question | its numbered answers | yes |
| A question Claude raises mid-implementation | the options it supplies | yes |
| A decision at a review-loop pause | the reviewer's and the planner's positions | yes |
| A permission request | Allow, Deny | yes |
| The cycle limit | Proceed, Stop | yes |
| Confirm the summary | Confirm | no — one action |
| Start planning | Start planning | no — one action |

Quit is present on every prompt as an escape from the program, not as an option of the question, and
does not make a single-action prompt into a choice.

The offer is **one button per question**, not one per option: the analysis covers the whole decision.
Its label is "Help me Decide".

The rule binds both interfaces. The page shows a button; the terminal, which has no buttons, offers
it the way it offers every other choice.

## 2. What happens when it is taken

A decision loop runs. It has the same shape as the four review loops the program already runs, and
for the same reason: a single pass by one agent is not trusted, so the other reviews it and the two
cycle until the reviewer raises nothing.

1. Claude Code produces the representation of the arguments, following `docs/decision-making.md`.
2. Codex reviews it against that same document and against the context of the run.
3. Claude Code responds to each issue with one of the five dispositions, as in every other loop.
4. Cycles continue until a review raises no counted issue.
5. The representation is shown to the user, who then answers the original question.

The pause conditions of decided behavior 7 apply unchanged, including the cycle limit — and the
prompt at that limit is itself a choice between options, so it too carries the offer.

Validation follows decided behavior 10: a reply that does not match its schema is kept in
`invalid-replies/` and the agent gets one repair turn; a second mismatch stops the run.

The analysis call is a planning call under decided behavior 3. It may write only under
`plan-review/`, and it cannot reach the network. Everything it reasons from must already be in the
project or in the prompt.

## 3. Where it sits in a run

A decision loop is a loop inside a phase, exactly as the question review sits inside requirements
gathering and the plan review sits inside planning. It is not a phase of its own.

Nothing about the run's phases changes. The user who was answering question 3 is still answering
question 3 afterward. The progress panel is unchanged.

Unlike the existing loops, a decision loop can occur inside any phase, so its name alone does not say
where it happened. Decisions are therefore numbered in order across the whole run — decision 1,
decision 2, decision 3 — and the phase recorded alongside them in the checkpoint says where each one
took place.

**Decisions may contain decisions.** While a decision loop runs, Claude may ask the user something,
and that question carries the offer like any other. The nesting is unbounded in principle; in
practice it is bounded by the user, who must press the button each time.

## 4. Records

Decided behavior 8 fixes the records of every loop, and `src/artifacts.ts` is the catalog that no
workflow may bypass. A decision loop needs its own entries, which means behavior 8 is amended — the
developer's instruction is required for that.

| What | Proposal |
|---|---|
| `SubjectId` variant | `{ decision: k }`, k counted across the run |
| Subject directory | `decision-<k>/` |
| Per-cycle files | `review-<n>.json`, `cc-<n>.json`, `round-<n>.json`, as every loop has |
| Log file | `decision-log.json`, `{ version: 2, entries }` — a fifth log; behavior 8 currently names four |
| Reviewed file | `decision-<k>/analysis.json`, a new artifact kind |
| Issue id prefix | `D<k>-R<n>-<i>` |
| Checkpoint subject | `decision-<k>`, with the phase in the existing `phase` field |

`guardedRecord` needs no change: it is a denylist, so new paths under `plan-review/` are guarded
automatically.

The question that prompted the decision, the representation, and the option the user finally chose
should all be recoverable afterward. `user-decisions.md` already records the user's decisions at
review pauses and is the natural place for the choice; the representation itself is the reviewed
file above.

## 5. The representation is structured data

Not prose. Codex must review it against a specification with numbered requirements, and the page must
render columns, nested argument chains and cross-references, so the shape has to be machine-readable.
That means a new Effect Schema in `src/schema.ts`, which also generates the JSON Schema the agents
receive.

The shape follows `docs/decision-making.md`. Four things in that document drive the design:

- **Every entry has seven elements** (§37): comparative condition, starting cause, intermediate
  steps, threshold, effect on persons, reason the effect matters, extent of the effect. The extent
  has four parts of its own (§45). These are fields, not free text, even though each is written as
  prose sentences.
- **Counterarguments nest without limit** (§93): under each counterargument its defenses, under each
  defense its further counterarguments, "until no further counterargument or defense exists". The
  schema is therefore recursive. Whether Effect Schema's recursive types survive the JSON Schema
  generation that both agents accept is the first thing to verify — the seven existing schemas were
  proved to work in `prototypes/proto-schema.ts`, and this one should be proved the same way before
  it is built.
- **Entries are cross-referenced by symbol** (§111, §113): a counterargument equivalent to an entry
  elsewhere is written once and marked, and the symbols are assigned in a fixed sequence. Symbols are
  a rendering concern derived from the references; the data needs stable entry identifiers so that a
  reference points at something, and the renderer assigns the symbols.
- **Reversals point at entries too** (§105), and are listed in full in a column while appearing as a
  single sentence with a symbol under the entry they counter.

An open question for the schema: the document requires that a claim derived by reasoning must not be
labeled as reasoning (§55), and that unknown values are stated as unknown with the measurement that
would settle them (§57). Both are properties of the prose inside a field, so neither is enforceable
by the schema; they are for Codex to check in review.

## 6. Context

`docs/decision-making.md` requires the system, its users and its constraints as input (§15), and
forbids assuming a value the input does not contain (§17).

The prompt should therefore carry whatever exists at that moment: the task, `requirements.md` and
`plan.md` when they exist, the phase, and the question itself with its options. The project is
readable during a planning call, so Claude can consult the code.

The hardest case is the earliest one. During requirements gathering there is no `requirements.md` and
no `plan.md`, and that is exactly where the user is most likely to want help. Analyses there will be
dense with "this is unknown", which the document requires rather than forbids, but the developer
should see one before judging whether it is useful.

## 7. Showing the result

`docs/decision-making.md` specifies one column per option (§65). That is straightforward on a wide
window and impossible at 390 px, where the page already shows one panel at a time.

What has to be decided:

- **Where it appears.** In the transcript as a message, or on a surface of its own. Issue #22 already
  asks whether status content belongs in the chat; a full argument representation is much larger than
  anything the chat carries today, so a separate surface — a sheet or a dialog over the panel, with
  the original question and its buttons still reachable — is the likelier answer.
- **Narrow windows.** Columns become sections, one option after another, with the same content.
- **The terminal.** It has no columns. One option after another, with indentation for the nested
  arguments.
- **The recommendation** (§117) is optional in the document. Whether Interloq asks for one, and
  whether it is shown, is the developer's choice.

Two details from the document that the renderer owns rather than the agent: the headings
"Disadvantages:" and "But:" that introduce the arguments against an entry (§69), and the symbol
sequence (§113).

One ambiguity in the document itself, worth resolving before implementation: §69 introduces the
arguments against an advantage with the heading "Disadvantages:", while §65 uses the same word for
the second half of every column. The same word denotes two different things, which will confuse both
the renderer and the reader.

## 8. What this costs

A decision loop is a full review loop: at least one Claude Code call and one Codex turn, and more if
the review raises issues. The completeness requirement (§61) — every argument an informed person
could make, every counterargument, every defense — is unbounded by construction, and Codex reviewing
for completeness has an obvious way to raise an issue in every cycle.

Two consequences the developer should weigh:

- **The cycle limit is the only bound**, and reaching it produces a prompt that itself offers the
  button.
- **A permission request is answered with an agent call in flight.** Claude is mid-turn, waiting.
  Taking the offer there holds that call open while a second agent conversation runs to convergence
  inside it. This works, but it is a different kind of interruption from the others, and it is worth
  knowing that the paused call's session is held for the duration.

## 9. Out of scope

- No change to the progress panel.
- No change to the phases of a run or to their numbering.
- No change to `docs/decision-making.md`, which is the authority for the analysis and is the
  developer's to edit.

## 10. What is still open

1. The word that replaces "interview" (issue #24), since this note uses "clarification".
2. Whether the recommendation (§117) is requested and shown.
3. Where the representation appears in the page, and its behavior at 390 px.
4. The §69 heading ambiguity above.
5. Whether a recursive schema survives the JSON Schema generation both agents accept — to be proved
   in `prototypes/` before the work starts, as every other schema was.
