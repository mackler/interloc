# Review of the web page (plan step 4.7, 26 Sep 2026)

The page (`web/src/`) checked against Jakob Nielsen's ten usability heuristics and against Material Design 3,
as CLAUDE.md's section "User interface" requires. "Changed" names what this review changed; each change has a test.

## Nielsen's heuristics

| Heuristic | Where the page satisfies it | Changed in this review |
|---|---|---|
| 1. Visibility of system status | Timeline rail with the whole run as far as it is known (issue #6): every phase done, active, stopped, ahead or not reached, the rounds per review loop, and the plan's stages and steps under the Implementation that carries it out, with the step being worked on marked only while an execution call runs; an indeterminate progress indicator while an agent works, with the measured time of the current call beside it (issue #42); activity line with the current agent call and its last tool use; the connection chip in the app bar ("connected", "reconnecting…"); a notice when a queued action was discarded | — |
| 2. Match between the system and the real world | Two chat panels like a messaging app, with the authors named (Interloq, You, Codex, Claude Code); the agents' Markdown rendered | Prompts were shown with the terminal's key conventions ("Enter = none, q = quit >"), which do not exist in the page; they are now stated in the page's words (`pagePromptText` in `src/prompts.ts`), and the buttons carry the choices. That removal was incomplete (finding 8 of `docs/gui-review.md`): the interview's opening still taught the terminal's `"""` convention, which the page does not implement. The opening is now the event `InterviewOpened`, which the terminal renders with `"""` and the page with Shift+Enter (`interviewHelp` in `src/prompts.ts`) |
| 3. User control and freedom | Stop task at any time (like Ctrl+C); Quit at every prompt, as in the terminal; the chat does not scroll away from a user who has scrolled up (a "new messages" chip instead); New task after the end | — |
| 4. Consistency and standards | Every button sends exactly the text the terminal would receive; one top app bar; M3 components and colour roles throughout | — |
| 5. Error prevention | Start is disabled until the directory and the task are filled and no run is active; the path is checked by the server before a run starts (a worktree's top-level directory); an unsent draft belongs to its prompt, and an answer from another tab withdraws it with a notice that quotes it, instead of leaving it under the next prompt; Enter while an input method is composing does not send; a failure to remember the directory never blocks Start; Stop is outlined, labelled "Stop task", placed in the app bar away from the prompt, and disabled without a run (no confirmation dialog, which behaviour 1 excludes) | — |
| 6. Recognition rather than recall | The directory browser; the last project path remembered; the fixed choices of a prompt as buttons; the interview's numbered answers and the options of a relayed question as cards that show the whole option (issue #12) | — |
| 7. Flexibility and efficiency of use | Buttons for the fixed choices and typing where free text is meaningful; Enter sends (Shift+Enter for a new line in a message), and a visible Send button does the same for touch and discovery | Findings 5 and 6 of `docs/gui-review.md`: a draft stayed attached to the next prompt after another tab answered, and Enter answered while an input method was composing. Both are fixed and tested (the draft over a live answer and over a replay; composition on both fields) |
| 8. Aesthetic and minimalist design | Only the newest run is shown; the agents' exchange is in its own panel; blank terminal lines and the interview's duplicated lines are not shown | Found in the end-to-end check (stage 5): an agent's message repeated its author as a "### Codex" heading, a review without issues showed only that heading, and the timeline repeated "Planning phase 1" under "Planning 1". The heading is dropped, an empty review reads "No issue: the review has converged.", and a phase names its review loops only when it has more than one |
| 9. Help users recognize, diagnose, and recover from errors | The server's refusal (a missing path, not a git repository, a run in progress) is the field's error text; halts and interruptions appear as the program's messages with the terminal's text, naming where the state is kept; answers made for an ended run are reported as not sent | — |
| 10. Help and documentation | The form's supporting texts; the answer fields' persistent labels ("Your answer", "Your message") and the hint under them; the interview's opening help in the page's own terms | The form did not say what happens after Start; it now explains the procedure in two sentences, where the records are kept, and what Stop task does |

## Material Design 3

- **Components** (m3-svelte 7.2.1): `Button` (filled for the primary action, tonal for other choices, outlined for Stop, Quit and Browse, text for Cancel), `Card` (outlined, one per option an agent proposes; issue #12), `TextFieldOutlined`, `TextFieldOutlinedMultiline`, `Dialog` (the directory browser), `Chip` (assist, elevated: "new messages"). Written by hand after the M3 guidelines, because m3-svelte has no such component: the indeterminate linear progress indicator (issue #42) and the rich tooltip of a plan step (issue #6).
- **Colour roles** from the tonal-spot 2025 scheme of m3-svelte's live theme (`--m3v-source`), light and dark through `color-scheme` / `light-dark()`: surface and surface containers for the panels, secondary container for the active phase, primary container for the user's messages, tertiary and secondary containers for Codex and Claude Code, error container for the reconnecting chip and the notices.
- **Typography**: the M3 type scale classes (`m3-font-title-large` for the app bar, `title-small` for panel headings, `body-*` for messages, `label-*` for authors and the chip).
- **Elevation**: the app bar at level 2; the dialog at m3-svelte's dialog elevation; the "new messages" chip elevated.
- **States**: disabled, hover, focus and pressed states come from m3-svelte's buttons; the hand-styled directory rows and answer fields have hover and focus-visible states in the scheme's colours.
- **Motion**: the indeterminate progress indicator's travelling segment (`web/src/theme.css`), replaced by a slow pulse in place when the user prefers reduced motion.
- **Deviations**, each with what the substitute asserts, as CLAUDE.md's substitution rule requires (issue #43):
  - *The busy indicator.* Until 28 Sep 2026 `LinearProgressEstimate` of m3-svelte stood in for M3's indeterminate linear progress indicator, which m3-svelte lacks. It was not a substitute but a different statement: it filled the track over time toward completion, so it asserted an estimate of how much of the work was done and a coming end, which the program does not know (issue #42). It is replaced by the indeterminate indicator written by hand after M3 (`web/src/theme.css`, `TimelineRail.svelte`): a segment that travels along the track without end, `role="progressbar"` without `aria-valuenow`. It asserts that an agent is working, and nothing about how much remains, as the specified component does.
  - *The elapsed time beside it* ("running for m:ss") is an addition, not a substitute: it asserts the time measured since the publication of the current call's start event, which the program knows, and no estimate. A call nested in another (a decision inside an execution call) shows its own time, and the outer call's again when it ends.
  - *The marks of phases and steps* are text glyphs rather than Material Symbols, because an icon set would be another dependency: ✓ done, ● in progress, ■ stopped, ○ ahead, a muted ○ not reached; for a step of the plan ✓ done, ● in progress, ◐ begun and not finished, ○ not begun. Each asserts the state its accessible name gives, the same state an icon would, and nothing more: no count, no progress within a step. A step is marked in progress only while an execution call runs; a step the last call began and did not finish is marked as such, not as current.
  - *The rich tooltip of a plan step* is written by hand after M3's rich tooltip, which m3-svelte lacks (`StepTooltip.svelte`): the surface container role, elevation level 2, the medium shape, a size limit with its own scrolling, placed inside the viewport, opened by hover and by keyboard focus, kept open by a click or tap, closed by Escape or leaving. Opened by hover, it stays open while the pointer moves from the step into it (a grace delay of 150 ms, W1-R1-1), so that a long text can be scrolled with the mouse. It asserts what the specified component asserts: supplementary text about the step it describes (the step's full text from the plan, rendered from Markdown and sanitized). It has no actions, so it claims no control the rich tooltip would offer.
  - *The answer fields* are m3-svelte's outlined text fields with persistent labels, not substitutes; the deviation is their key behaviour: Enter sends, Shift+Enter adds a line in a message, and a filled Send button sits beside them. The fields assert what an outlined text field asserts, a place to type an answer; the hint under them states the keys, so the behaviour is not left to be guessed.

## Layout across window sizes (finding 7 of `docs/gui-review.md`, 26 Sep 2026)

The page was a fixed grid of a 14rem rail and two equal panels. At 390 px each panel was 59 px wide and the page
overflowed sideways; at a 200 % zoom of a desktop window (a 640 × 400 CSS viewport) the panels were 184 px wide. The
layout now follows M3's window size classes (`web/src/layout.ts`, `App.svelte`, `TopBar.svelte`):

- **Expanded (840 px and wider)**: unchanged, the rail and both panels side by side.
- **Below 840 px**: the rail becomes a one-line disclosure ("Progress: Planning 1, round 2 of 5") that opens the whole
  rail [visibility of system status: the current phase stays in view; aesthetic and minimalist design: the detail
  is one tap away]. One panel is shown at a time, chosen in an M3 segmented group labelled with the panels' own titles
  [consistency and standards: the same names as the wide page; recognition rather than recall]. The hidden panel's
  button counts its new messages ("· 3 new") [visibility of system status], and a new prompt selects "You and
  Interloq", where it is answered; otherwise only the user changes the panel [user control and freedom]. Below
  that height the page scrolls vertically, and a panel keeps at least 12.5rem.
- **The top bar** wraps: the title, the connection and Stop stay on the first line (the title at M3's 22 px below
  600 px), and the project and the task move to a second line.
- **The answer field** has the full width in every window, with the hint and Send on the row beneath it.
- **Corrections after work review 2** (W2-R1-1 to W2-R1-3): both panels stay mounted and CSS alone hides one, so a
  switch or a resize across 840 px keeps each panel's reading position [user control and freedom]; a panel that was
  hidden goes to its end when shown again if it was following, and otherwise keeps the user's place with the chip
  counting what arrived; the latest notice stands above the panels in a compact window, so the server's end or a
  withdrawn draft is seen whichever panel is shown [visibility of system status]; a new prompt is recognised by its
  full identity, so a new run's first prompt selects "You and Interloq" after a reconnection too.

`e2e/layout.spec.ts` checks, at 390 × 844 and at 640 × 400, that nothing overflows sideways, that the shown panel is
at least 300 px wide (and 400 or 200 px high) and the answer field at least 280 px wide, the panel switch, the badge
and the selection by a prompt; and at 1280 × 800 that the rail and both panels stand side by side.

## The agents' options as cards (issue #12, 27 Sep 2026)

An interview turn's numbered answers and a relayed question's options were m3-svelte `Button`s in the row of the
fixed choices, the first filled. An option can run to a paragraph, and a button's fixed 40 dp height cannot hold one:
the label spilled out of every button, over its neighbours in a wide window and below it in a narrow one. The
developer's decisions of the interview:

- **Cards with the full text** (Q1): each option is an outlined M3 `Card` rendered as a native button, one per row in
  a group named "Proposed answers", above the fixed choices. The user reads the whole option where it is chosen
  [error prevention; recognition rather than recall]; the repetition of the text of the message above is accepted for
  that. The card sends only the number, as the button did, and is operated by keyboard like any button.
- **The transcript keeps the full line** (Q2): the user's message is the chosen option's whole line.
- **No implied default** (Q3): every option has the same variant, because the agent's first option is not
  necessarily its default [consistency and standards]; the fixed prompts keep their filled primary action.
- **Both kinds of agent option** (Q4): the interview's and a relayed question's.

Several paragraphs scroll within their group (at most a quarter of the window's height), so that the answer field,
Send and the fixed choices stay in a phone's window. `e2e/layout.spec.ts` (L9) checks, at 390 × 844 and at
1280 × 800, that each of three paragraph options fits its card, that nothing overflows sideways, that the field,
Send and End interview are in the window, and that a card chosen with the keyboard sends its number and leaves its
full line in the transcript. The terminal is unchanged: it never rendered these choices.
