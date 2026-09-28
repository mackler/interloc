// Prompt texts. All paths are relative to the project directory.

import { pathOf } from "./artifacts.ts";
import type { LogEntry, Review } from "./schema.ts";
import type { InterviewStage } from "./uiEvents.ts";

const SEVERITY = `Severity: blocking = the work cannot succeed with the file as written; major = the file as written will produce a defect or omits something required; minor = everything else.`;

/** Rules for the use of an issue log. They are the same for every reviewed file. */
function logRules(logFile: string, idPrefix: string, round: number): string {
  return `plan-review/${logFile} is a JSON object whose 'entries' list every issue raised in earlier rounds with the planner's disposition and rationale, in order.
Every entry has id, phase, round, source, problem, action, rationale and superseded. An entry with superseded = true has been replaced by a later entry with the same id; use the later entry.
An entry with source 'review' is an issue you raised: it also has severity, location, evidence, the planner's action ('accepted', 'partially_accepted', 'rejected', 'no_change_needed' or 'clarification_requested'), and duplicate_of and reverses, each the id of an earlier issue or null.
An entry with source 'self_correction' records a correction that the planner made to its own earlier work (action 'accepted', 'plan_error' or 'correction_disputed').
An entry with source 'user' (action 'decided_by_user') contains a decision of the user on that issue, which must be followed.
The rationale of every entry is addressed to you; read it irrespective of the action.
plan-review/reviewer-feedback.md contains feedback from the planner that concerns no single issue; take it into account.
For an entry with action 'clarification_requested', the rationale contains a question to you: if the issue is valid, raise it again under the same id and answer the question in the evidence field; if the question shows the issue to be mistaken, omit the issue.
plan-review/user-decisions.md contains input and decisions by the user, which must be followed; do not raise an issue that contradicts them.
Do not repeat an issue whose action is 'accepted' unless the file still contains the defect.
Do not repeat an issue whose action is 'rejected', 'no_change_needed', or 'partially_accepted', under the same or a different wording, unless you can state a specific error in the rationale; in that case reuse the original id and state the error in the evidence field.
Do not raise an issue whose correction would undo the correction made for an accepted issue in the log; if you consider an accepted correction wrong, reuse the id of that issue and state the error in the evidence field.
${SEVERITY}
Return an empty issues array when no issue is found.
New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

function laterRound(file: string, logFile: string, idPrefix: string, round: number): string {
  return `The planner has answered your issues; the answers are in plan-review/${logFile}, and plan-review/${file} may have been amended.
Read both files again and review plan-review/${file} again under the same rules as before. New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

/** How a question for the user is filled (decision Q1 of the decision-support task). */
export const QUESTION_OPTIONS_RULE = `Each entry of questions_for_user has a question and options. When the question is a choice, give two or more mutually exclusive options, each with a short label and a description; otherwise return an empty options array.`;

/** Rules for Claude Code's answer to a review. 'amendment' names what an accepted issue requires. */
function respondRules(amendment: string): string {
  return `plan-review/user-decisions.md contains input and decisions by the user, which must be followed.
Evaluate each issue critically against the codebase; do not assume the reviewer is correct.
Choose one action for each issue.
'accepted': the issue is valid and ${amendment}.
'partially_accepted': a part of the issue is valid; act on that part and state in the rationale which part you do not accept and why.
'rejected': the issue is mistaken; no amendment.
'no_change_needed': the concern is valid, but the file already satisfies it or it is outside the task; no amendment; state where the file satisfies it or why it is outside the task.
'clarification_requested': you cannot evaluate the issue without an answer from the reviewer; no amendment; put the question in the rationale.
Every rationale is addressed to the reviewer and is returned to the reviewer irrespective of the action; use it for any feedback on the issue, including feedback on an accepted issue.
Put in reviewer_feedback any feedback to the reviewer that concerns no single issue, for example a wrong assumption that several issues share; otherwise return an empty string.
If an issue repeats an earlier issue under a different id, set duplicate_of to the earlier id; otherwise set it to an empty string.
If acting on an issue would undo a correction that you made for an earlier accepted issue, do not act on it: set action to 'rejected', set reverses to the id of the earlier issue, and explain the conflict in the rationale; the user will decide. Otherwise set reverses to an empty string.
Independently of the current issues: if you determine that one of your earlier dispositions, or a part of the file, was wrong, report it in self_corrections with an explanation addressed to the reviewer.
Use new_action 'accepted' with the id of an issue that you rejected earlier and now accept; act on it.
Use new_action 'rejected' with the id of an accepted issue whose correction you now consider wrong; do not act on it, the user will decide.
Use new_action 'plan_error' with an empty id for an error that concerns no issue; correct it.
Return an empty self_corrections array when there is none.
Return exactly one disposition per issue id. Put in questions_for_user only questions that the user alone can answer.
${QUESTION_OPTIONS_RULE}
Do not use the AskUserQuestion tool.`;
}

// ---- question list ------------------------------------------------------------------------------

export function questionListPrompt(task: string): string {
  return `Do not write a plan yet. Read the task below and inspect the codebase without changing anything.
Return in 'questions' the questions whose answers you need from the user before you can write an implementation plan for the task.
Include a question only if its answer affects the plan and neither the task text nor the codebase nor the project documentation determines it.
Each entry has these fields. id: Q1, Q2, and so on. question: one decision per question. reason: why the plan depends on the answer, and why the codebase does not determine it, with the files you inspected. proposed_answers: two to four answers that are feasible in this codebase, each with a label and a description. default_answer: the label of the proposed answer that you would assume if the user expressed no preference.
Return an empty list if no question is needed. Do not modify any file. Do not use the AskUserQuestion tool.
Task: ${task}`;
}

export function questionReviewPrompt(round: number): string {
  if (round > 1) return laterRound(pathOf({ kind: "questions" }), pathOf({ kind: "log", subject: "questions" }), "Q", round);
  return `Review the question list in plan-review/questions.json against the task text in the same file and against the codebase. Do not modify any file.
The planner will ask the user these questions in an interview and will then write an implementation plan from the answers.
Raise an issue when: a question whose answer the plan needs is missing; a question is unnecessary because the task text or the codebase determines the answer (name the file); a question is ambiguous or combines several decisions; a reason is wrong; a feasible answer is missing from the proposed answers, or a proposed answer is not feasible in this codebase; a default contradicts the task or the codebase.
Put the question id, or 'list' for an issue that concerns the list as a whole, in the location field.
${logRules(pathOf({ kind: "log", subject: "questions" }), "Q", round)}`;
}

export function questionRespondPrompt(round: number): string {
  return `plan-review/question-review/review-${round}.json contains a review of the question list in plan-review/questions.json.
${respondRules("you amend the question list for it")}
Return in 'questions' the complete question list after your amendments, including the entries that did not change. Do not modify any file.`;
}

export const questionApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file.
Return in 'questions' the complete question list of plan-review/questions.json, amended where a decision requires it. Do not modify any file.`;

// ---- interview ----------------------------------------------------------------------------------

const INTERVIEW_RULES = `Rules for the interview.
Each of your turns produces these output fields. message_to_user: the text that the program shows to the user; plain text without Markdown tables. asked_ids: the ids of every question you have asked so far: the agreed questions you have asked, and an id F1, F2, … that you assign to each follow-up question. answered_ids: the ids of the questions, agreed or follow-up, that the user has answered so far. complete: true only when every agreed question has been answered and you need nothing further from the user. summary: an empty string while complete is false.
When complete is true, summary contains the complete requirements document in Markdown: the task; every decision with the id of its question; the further information and constraints that the user gave; and open points, each with the default that will be assumed.
Ask one question per message. For an agreed question, show each proposed answer on its own line in the form \`<n>. <answer>\`, numbered from 1, name the default, and state the reason in one sentence. The user may answer with a number, a label, or free text.
You may ask any follow-up question that the conversation makes necessary. The user may raise any subject and may ask you questions; answer them, and inspect the codebase without changing it where that is needed.
Do not use the AskUserQuestion tool; the program relays the conversation. Do not modify any file. Do not write a plan.`;

export const interviewOpenPrompt = `Conduct an interview with the user. plan-review/questions.json contains the task and the agreed questions. Cover every agreed question, in the order of the list unless the conversation makes another order more useful.
${INTERVIEW_RULES}
Begin now with your first message to the user.`;

export function interviewOpenEmptyPrompt(firstMessage: string): string {
  return `The agreed question list in plan-review/questions.json is empty. The user has chosen to add information before planning starts. Conduct the conversation with the user.
${INTERVIEW_RULES}
The user's first message:
${firstMessage}`;
}

export function interviewGapsPrompt(reviewFile: string, ids: string[]): string {
  return `The reviewer has examined plan-review/requirements.md, the confirmed result of the interview. ${reviewFile} contains the review. You accepted these issues: ${ids.join(", ")}.
Conduct a second interview with the user on those points only. Treat each accepted issue as an agreed question; use the issue ids in asked_ids and answered_ids.
${INTERVIEW_RULES}
When complete is true, summary contains the complete revised requirements document, not only the changes.
Begin now with your first message to the user.`;
}

export const interviewDonePrompt = `The user ends the interview now. Return complete = true. In the summary, list every agreed question that was not answered under 'Open points', with the default that will be assumed.`;

export function interviewUserMessage(text: string): string {
  return `User: ${text}`;
}

export function interviewNotConfirmed(text: string): string {
  return `The user does not confirm the summary and writes:\n${text}\nContinue the conversation. Return complete = true with the revised summary when the point is resolved.`;
}

// ---- requirements -------------------------------------------------------------------------------

export function requirementsReviewPrompt(round: number): string {
  if (round > 1) return laterRound(pathOf({ kind: "requirements" }), pathOf({ kind: "log", subject: "requirements" }), "G", round);
  return `Review plan-review/requirements.md. It is the result of an interview between the planner and the user, confirmed by the user. plan-review/questions.json contains the task and the questions that were agreed before the interview. Do not modify any file.
The planner will write an implementation plan from the task and this file.
Raise an issue when: an agreed question has no clear answer in the file; two statements in the file contradict each other; a statement cannot be followed in this codebase (name the file); a decision that the plan needs is still absent.
Put the question id or the heading in the location field.
${logRules(pathOf({ kind: "log", subject: "requirements" }), "G", round)}`;
}

export function requirementsRespondPrompt(round: number): string {
  return `plan-review/requirements-review/review-${round}.json contains a review of plan-review/requirements.md.
${respondRules("the point must be put to the user; the program will conduct a second interview on the accepted issues, so do not amend the file yourself")}
Do not modify any file.`;
}

export const requirementsApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend plan-review/requirements.md where a decision requires it. Do not modify any other file.
Return an empty questions_for_user array.`;

// ---- plan ---------------------------------------------------------------------------------------

export function initialPlanPrompt(task: string, withRequirements: boolean): string {
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions from the interview. The plan must follow it.\n"
    : "";
  return `Produce an implementation plan for the task below. Investigate the codebase as needed.
${requirements}Write the plan to plan-review/plan.md as numbered steps, each with a marker that shows whether the step is completed.
Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be written; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}
Task: ${task}`;
}

export const revisePlanPrompt = `Execution has stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop.
Revise plan-review/plan.md for the remaining work: keep the completed steps and their markers, and change, add, or remove remaining steps as the user's input and the current state of the codebase require.
If no change to the plan is required, leave the file unchanged. Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}`;

export const planApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend plan-review/plan.md where a decision requires it. Do not modify any other file.
Return an empty questions_for_user array.`;

export function planReviewPrompt(phase: number, round: number, withRequirements: boolean): string {
  const prefix = `P${phase}`;
  if (round > 1) return laterRound(pathOf({ kind: "plan" }), pathOf({ kind: "log", subject: { plan: phase } }), prefix, round);
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions. It must be followed; raise an issue when a plan step contradicts it or omits something it requires.\n"
    : "";
  return `Review the implementation plan in plan-review/plan.md against the codebase. Do not modify any file.
${requirements}Steps that the plan marks as completed are already implemented in the codebase; review the remaining steps, and review whether the remaining steps are consistent with the implemented state.
Put the step number or the heading in the location field.
${logRules(pathOf({ kind: "log", subject: { plan: phase } }), prefix, round)}`;
}

export function planRespondPrompt(phase: number, round: number): string {
  return `plan-review/planning-${phase}/review-${round}.json contains a review of plan-review/plan.md.
${respondRules("you amend plan-review/plan.md for it")}
Do not modify any file other than plan-review/plan.md.`;
}

export const executePrompt = `The plan in plan-review/plan.md has been reviewed. Implement its remaining steps in order.
After you complete a step, set its completion marker in plan-review/plan.md; do not change the content of the remaining steps.
If you need information or a decision from the user, or if a remaining step proves to be wrong, do not continue on an assumption: ask with the AskUserQuestion tool. After you have asked, make no tool call other than the final structured output; end your turn with status 'needs_input'.
If you cannot continue for another reason, for example a command that fails and that you cannot correct or a denied permission, stop and return status 'blocked' with the description in the question field.
When every step is completed and verified, return status 'finished'.
In every case put a summary of the work done in summary and a description of the steps not yet completed in remaining_work.`;

// ---- repair of an invalid structured reply ------------------------------------------------------

/** One repair turn in the same session or thread. `issue` is the formatted decode error. */
export function repairReplyPrompt(issue: string): string {
  return `Your structured output did not match the required schema:
${issue}
Return the complete output again, corrected. Do not modify any file.`;
}

// ---- prompts to the user ------------------------------------------------------------------------
// The texts the program shows when it waits for the user. src/userPrompts.ts maps each to its widget.

/** A decision at a pause (behaviour 7) or on a question from Claude Code. */
export function decisionPrompt(subject: string): string {
  return `Decision on: ${subject} (Enter = none, q = quit) > `;
}
/** The round limit, with the choice to proceed without convergence. The user reads "cycles" (issue #14). */
export function limitPrompt(limit: number, proceedLabel: string): string {
  return `${limit} cycles completed without convergence. Number = additional cycles; p = ${proceedLabel}; 0 = stop > `;
}
/** The round limit of a subject without a proceed choice (the work review, Q13). */
export function limitNoProceedPrompt(limit: number): string {
  return `${limit} cycles completed without convergence. Number = additional cycles; 0 = stop > `;
}
/** The user's input at a stop of an execution phase whose report carried none. */
export const execInputPrompt = "Your input for Claude Code (q = quit) > ";
/** The answer to a question that Claude Code asked with AskUserQuestion. */
export const optionOrTextPrompt = "Number or free text (q = quit) > ";
/** A permission request of Claude Code. */
export const permissionPrompt = "Allow? (y = yes, anything else = no, q = quit) > ";
/** A message of the interview. */
export const interviewMessagePrompt = "You > ";
/** The confirmation of the interview's summary. */
export const confirmSummaryPrompt = "Enter = confirm the summary; any other text continues the conversation > ";
/** The choice after an empty agreed question list (behaviour 2). */
export const startOrTalkPrompt = "\nClaude Code and Codex agree that no question is needed. Enter = start planning; any other text opens a conversation with Claude Code > ";

// ---- status lines to the user (issue #14: "Gather Requirements", "Implementation", "cycle") -----------------------

/** The start of the question phase. */
export const questionListLine = "Gather Requirements: Claude Code formulates the question list ...";
/** The start and the end of execution phase k. */
export function implementationBeganLine(k: number, permissionMode: string): string {
  return `\nImplementation phase ${k}: Claude Code implements the plan (permission mode ${permissionMode}) ...`;
}
export function implementationEndedLine(k: number, status: string): string {
  return `\nImplementation phase ${k} ended with status: ${status}`;
}
/** The end of a finished run. */
export function taskFinishedLine(phases: number): string {
  return `\nClaude Code reports that the task is finished after ${phases} implementation phase(s).`;
}
/** An AskUserQuestion stop of an execution call. */
export const IMPLEMENTATION_STOPPED_LINE = "\nClaude Code has stopped implementation with a question.";
/** The proceed choices of the subjects at the cycle limit (the work review has none). */
export const PROCEED_TO_CLARIFICATION = "proceed to the clarification with the question list as it is";
export const PROCEED_TO_PLANNING = "proceed to planning with the requirements as they are";
export const PROCEED_TO_IMPLEMENTATION = "proceed to implementation with the plan as it is";
/** The "p" choice at the cycle limit of a decision loop (D10 of the decision-support plan). */
export const PROCEED_TO_CHOICE = "proceed to your choice with the analysis as it is";
/** The review loop's lines: a cycle's review and response. */
export function cycleReviewLine(heading: string, n: number): string {
  return `\n${cycleHeading(heading, n)}: Codex review ...`;
}
export function cycleResponseLine(heading: string, n: number): string {
  return `${cycleHeading(heading, n)}: Claude Code response ...`;
}
/** The counts listed at the cycle limit. */
export function cycleCountsLines(heading: string, counts: readonly number[], costs: readonly (number | null | undefined)[]): readonly string[] {
  return [`\nCounted issues and reported Claude Code usage per cycle of ${heading}:`, ...counts.map((c, i) => `  cycle ${i + 1}: counted issues = ${c}, total_cost_usd = ${costs[i] ?? "not reported"}`)];
}
/** Behaviour 7's pauses in the user's words: identical content, idle cycles, an unexplained change. */
export function identicalContentLine(fileLabel: string, cycle: number, seen: string): string {
  return `\n${fileLabel} after cycle ${cycle} is identical to ${fileLabel} after ${seen} (cycle 0 is the state at the start).`;
}
export function observedAfter(cycle: number, afterDecision: boolean): string {
  return afterDecision ? `cycle ${cycle} (after the user's decision)` : `cycle ${cycle}`;
}
export function alternatingSubject(fileLabel: string): string {
  return `which of the two alternating versions of ${fileLabel} is correct`;
}
export function idleLine(idle: number, cycle: number): string {
  return `\nClaude Code accepted no issue in ${idle} consecutive cycles. Issues of cycle ${cycle} without amendment:`;
}
export function idleSubject(idle: number): string {
  return `the issues of the last ${idle} cycles that produced no amendment`;
}
export function unexplainedChangeLine(fileLabel: string, cycle: number): string {
  return `\n${fileLabel} changed in cycle ${cycle} without an accepted issue, a self-correction, or a user decision.`;
}
export function unexplainedChangeSubject(fileLabel: string, heading: string, cycle: number): string {
  return `the unexplained change to ${fileLabel} in ${cycleHeading(heading, cycle)}`;
}

/** The halt at the cycle limit, and a cycle whose round failed validation, as the user reads them (issue #14, W1-R1-1). */
export function cycleLimitStopText(heading: string): string {
  return `stopped by the user at the cycle limit of ${heading}`;
}
export function analysisInvalidText(parts: readonly string[]): string {
  return `the decision analysis is invalid: ${parts.join("; ")}`;
}
export function decisionFormatUnreadableText(file: string, message: string): string {
  return `the decision-making format ${file} could not be read: ${message}`;
}
export function cycleInvalidText(parts: readonly string[]): string {
  return `the cycle is invalid: ${parts.join("; ")}`;
}

// ---- work review ----------------------------------------------------------------------------------

/** What the work review of phase k ended with: convergence, or leaving for a planning phase in a round. */
export type WorkReviewEnd = "converged" | Readonly<{ revisedInRound: number }>;

export function workReviewPrompt(phase: number, round: number, withRequirements: boolean): string {
  const prefix = `W${phase}`;
  const log = pathOf({ kind: "log", subject: { work: phase } });
  const changes = pathOf({ kind: "changes", phase });
  if (round > 1)
    return `plan-review/${changes} has been rewritten from the current project for this round.
${laterRound(changes, log, prefix, round)}`;
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions. Raise an issue when the work contradicts it or omits something it requires of a completed step.\n"
    : "";
  return `Review the work done in the project since the run began. plan-review/${changes} is the diff of the project against its state at the start of the run (new files in full, committed changes included); read it and the project itself. Do not modify any file.
Review the work against plan-review/plan.md. Steps that the plan marks as completed are implemented; review their work against the plan. Steps not marked completed in plan-review/plan.md are not yet implemented, and missing work of those steps is not an issue.
${requirements}Raise an issue for work that does not implement a completed step, contradicts the plan or the requirements, or introduces a defect.
Put the file path, with a line number where it helps, in the location field.
${logRules(log, prefix, round)}`;
}

/**
 * What a response to a review is given besides the round (decision Q1 of the stage-A task): the review of the round,
 * the subject's log entries, and the change record of a work review (null for the other subjects).
 */
export type RespondContext = Readonly<{ review: Review; log: readonly LogEntry[]; changes: string | null }>;

/**
 * A work response is read-only (finding 1 of docs/gui-review.md): it may call no tool, so the prompt carries the
 * review, the entries of this work review's phase in the work-review log, and changes.diff verbatim.
 */
export function workRespondPrompt(phase: number, round: number, context: RespondContext): string {
  const entries = context.log.filter((e) => e.phase === phase);
  return `plan-review/${pathOf({ kind: "review", subject: { work: phase }, round })} contains a review of the work done in the project (the diff in plan-review/${pathOf({ kind: "changes", phase })}).
You cannot use any tool in this response: the review, the earlier entries of this work review's log and the diff are below, and what you did in the execution phase is in your context. Answer with the final structured output only.
${respondRules("the correction will be made in a later execution phase after the plan has been revised; do not modify any file")}
Every correction, including one that a self-correction calls for, is made in a later execution phase; state in the rationale what the correction requires.
Do not modify any file.

The review (${pathOf({ kind: "review", subject: { work: phase }, round })}):
${JSON.stringify(context.review, null, 2)}

The earlier entries of work review ${phase} in plan-review/${pathOf({ kind: "log", subject: { work: phase } })}:
${entries.length === 0 ? "(none)" : JSON.stringify(entries, null, 2)}

The diff (plan-review/${pathOf({ kind: "changes", phase })}):
${context.changes ?? "(not available)"}`;
}

export function revisePlanAfterExecutionPrompt(phase: number, end: Readonly<{ stopped: boolean; workReview: WorkReviewEnd }>): string {
  const stop = end.stopped ? "\nExecution stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop." : "";
  const review =
    end.workReview === "converged"
      ? `\nWork review ${phase} found no issue in the work so far.`
      : `\nWork review ${phase} ended in round ${end.workReview.revisedInRound} with accepted issues or a user decision: plan-review/${pathOf({ kind: "round", subject: { work: phase }, round: end.workReview.revisedInRound })}, plan-review/${pathOf({ kind: "log", subject: { work: phase } })} and the last entries of plan-review/user-decisions.md.`;
  return `Execution phase ${phase} has ended.${stop}${review}
Revise plan-review/plan.md: keep the completed steps and their markers, add steps that correct the accepted issues and follow the decisions, and change, add, or remove remaining steps as the current state of the codebase requires.
If no change to the plan is required, leave the file unchanged. Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}`;
}

/**
 * A prompt to the user in the web page's words: the same question without the terminal's key conventions, which
 * the page's buttons replace (plan step 4.7). `kind` is the prompt's kind in src/userPrompts.ts.
 */
export function pagePromptText(kind: string, offeredText: string): string {
  const text = withoutOffer(offeredText).text;
  const decision = decisionPrompt("\u0000").split("\u0000");
  switch (kind) {
    case "decision":
      return `Decision on: ${text.slice(decision[0].length, text.length - decision[1].length)}`;
    case "limit":
    case "limitNoProceed": {
      const cycles = /^[0-9]+/.exec(text)?.[0] ?? "The";
      return kind === "limit"
        ? `${cycles} cycles completed without convergence. Add cycles, proceed without convergence, or stop.`
        : `${cycles} cycles completed without convergence. Add cycles or stop.`;
    }
    case "execInput":
      return "Your input for Claude";
    case "optionOrText":
      return "Choose one of the options, or type your own answer.";
    case "permission":
      return "Allow this action?";
    case "interviewMessage":
      return "Your reply";
    case "confirmSummary":
      return "Confirm the summary, or write what should change.";
    case "startOrTalk":
      return "Claude and Codex agree that no question is needed. Start planning, or write a message to open a conversation with Claude.";
    default:
      return text.replace(/\s*>\s*$/, "").trim();
  }
}

/** The name of a conversation with the user as both interfaces show it (issue #21, Q5 follow-up). */
export function clarificationHeading(stage: InterviewStage): string {
  switch (stage) {
    case "clarification":
      return "Clarification";
    case "followUp":
      return "Follow-up clarification";
    case "conversation":
      return "Conversation before planning";
  }
}
/** The fixed choice that ends a clarification. */
export const END_CLARIFICATION = "End clarification";
/** The interview's opening help (finding 8 of docs/gui-review.md), for the terminal or the page. */
export function interviewHelp(heading: string, ui: "terminal" | "page"): string {
  return ui === "terminal"
    ? `\n${heading}. Commands: /done = end the clarification; /quit = end the run; """ on its own line starts and ends a message of several lines.`
    : `${heading}. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.`;
}

// ---- the page's help and notices (W2-R1-4) --------------------------------------------------------------------------
// Texts that the web page shows the user besides the prompts: the answer field's hint, the notices, the compact
// layout's progress line and badge. Field and button labels stay in the components.

/** The opening line of the page's message about a plan written in a planning phase (issue #5: the page says "Claude"). */
export function planWrittenHeading(phase: number): string {
  return `Claude wrote the plan (planning phase ${phase}).`;
}
/** The heading of the summary Claude proposes at the end of an interview, in the page. */
export const SUMMARY_PROPOSED_HEADING = "Summary proposed by Claude:";
/** The start form's description, in parts: plain text, a path, and the name of a button. */
export const START_FORM_DESCRIPTION: readonly Readonly<{ text: string; style: "plain" | "code" | "strong" }>[] = [
  { text: "Claude writes a plan, Codex reviews it until no issue remains, Claude implements it, and Codex reviews the work; the page asks you only where a decision is needed. The records are kept in the project's ", style: "plain" },
  { text: "plan-review/", style: "code" },
  { text: " directory. ", style: "plain" },
  { text: "Stop task", style: "strong" },
  { text: " ends a task like Ctrl+C in the terminal.", style: "plain" },
];

/**
 * The name of a phase as both interfaces show it (issue #14): the first phase gathers the requirements, and an
 * execution phase implements the plan. The records keep their own names (question-review/, execution-<k>/).
 */
export function phaseLabel(kind: "questions" | "planning" | "execution" | "work", n: number): string {
  switch (kind) {
    case "questions":
      return "Gather Requirements";
    case "planning":
      return `Planning ${n}`;
    case "execution":
      return `Implementation ${n}`;
    case "work":
      return `Work review ${n}`;
  }
}
/** The purpose of an agent call as the activity line names it: the events keep the program's words (issues #14, #21). */
export function purposeLabel(purpose: string): string {
  return purpose === "interview" ? "clarification" : purpose === "execution" ? "implementation" : purpose;
}
/** A cycle of a review loop in the user's words (issue #14): the records and the events say "round". */
export function cycleHeading(heading: string, n: number): string {
  return `${heading}, cycle ${n}`;
}

/** The label that opens a phase's band in a chat panel (issue #15): the phase's name and the time it began. */
export function phaseBandLabel(name: string, clock: string): string {
  return `${name} · ${clock}`;
}

/** The hint under the answer field. */
export function answerHint(free: "line" | "message"): string {
  return free === "line" ? "Enter sends." : "Enter sends; Shift+Enter starts a new line.";
}
/** The accessible name of the agent's options, the cards above the fixed choices (issue #12). */
export const PROPOSED_ANSWERS_LABEL = "Proposed answers";
/** Another tab answered the prompt this tab had an unsent draft for (finding 5). */
export function draftWithdrawnNotice(text: string): string {
  return `This question was answered in another tab; your unsent text was discarded: «${text}»`;
}
/** The server is ending (finding 15). */
export const SERVER_CLOSED_NOTICE = "The server has ended. The page reconnects when it is started again.";
/** The heading of the answers the page could not send (G-R1-1, P1-R1-2 of the defects' plan). */
export const UNSENT_HEADING = "Not sent";
const NOT_SENT_SUBJECT: Record<"answer" | "stop" | "start" | "list", string> = {
  answer: "Your answer was not sent",
  stop: "Stop was not sent",
  start: "The new task was not sent",
  list: "The directory listing was not requested",
};
const NOT_SENT_REASON: Record<"ended" | "restarted" | "disconnected", string> = {
  ended: "the run has ended",
  restarted: "the server has been restarted since",
  disconnected: "the page is no longer connected to the server",
};
/**
 * An action that was not sent: queued while disconnected and overtaken by the reconnection, or refused because the page
 * has stopped reconnecting. A disconnected answer says where its text is: in the answer field, or quoted and kept.
 */
export function notSentNotice(kind: "answer" | "stop" | "start" | "list", reason: "ended" | "restarted" | "disconnected", quoted?: string): string {
  const base = `${NOT_SENT_SUBJECT[kind]}: ${NOT_SENT_REASON[reason]}.`;
  if (kind !== "answer" || reason !== "disconnected") return base;
  return quoted === undefined ? `${base} Its text is still in the answer field.` : `${base} Its text is kept under “${UNSENT_HEADING}”: «${quoted}»`;
}
/** How much of a decode reason the notice shows; the console has it in full. */
const REASON_LENGTH = 200;
/** A frame of the server the page could not read (defect B of docs/page-question-phase-defects.md, decision Q2). */
export function protocolErrorNotice(reason: string): string {
  const shown = reason.length > REASON_LENGTH ? `${reason.slice(0, REASON_LENGTH)}…` : reason;
  return `The page could not read a message from the server; reconnecting. Reason: ${shown}`;
}
/** The page has stopped reconnecting after three frames in a row it could not read (decision Q5). */
export const CONNECTION_FAILED_NOTICE =
  "The page has stopped reconnecting: it could not read the server's messages three times in a row. Nothing you do here is sent any more, and your typed text is kept. Reload the page once the server has been fixed.";
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/**
 * A cycle of a review loop in the progress rail (issue #14, Q1): the issues its review raised, and the counted ones
 * when they differ; the cycle alone until its review arrives. No limit: the user may grant more cycles.
 */
export function cycleLine(n: number, raised: number | null, counted: number | null): string {
  if (raised === null) return `cycle ${n}`;
  return `cycle ${n}: ${count(raised, "issue", "issues")}${counted !== null && counted !== raised ? ` (${counted} counted)` : ""}`;
}
/**
 * The one line of a finished review loop (issue #14, Q2 and G-R1-1): the corrections of its cycles, resolved when the
 * loop converged or the user proceeded, due when it left for a revision (even 0, when a decision of the user ended it).
 */
export function loopSummary(cycles: number, corrections: number, result: "converged" | "proceed" | "revise"): string {
  const n = count(cycles, "cycle", "cycles");
  switch (result) {
    case "converged":
      return `${n} resolved ${count(corrections, "issue", "issues")}`;
    case "proceed":
      return `${n} resolved ${count(corrections, "issue", "issues")}, proceeded without convergence`;
    case "revise":
      return `${n}: ${count(corrections, "correction", "corrections")} due`;
  }
}
/** The steps of Gather Requirements in the progress rail (issue #21, Q5 and Q7). */
export function stepLabel(kind: "formulate" | "clarification" | "followUp"): string {
  return kind === "formulate" ? "Formulate questions" : kind === "clarification" ? "Clarification" : "Follow-up clarification";
}
/** A clarification's count (issue #21, Q6): the total grows with the follow-ups Claude asks. */
export function clarificationProgress(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}
/** A phase and its active step, as the compact progress line names them. */
export function stepOfPhase(phase: string, step: string): string {
  return `${phase} — ${step}`;
}
/** The progress rail's heading and its text before any phase (issue #14, Q4: unchanged). */
export const PROGRESS_HEADING = "Progress";
export const NO_PHASE_YET = "No phase has begun.";
/** The one-line progress of a compact window: the current phase or step, and its detail (the latest cycle, a count), or none. */
export function progressLine(label: string | null, detail: string | null): string {
  if (label === null) return "Progress: no phase has begun";
  return `Progress: ${label}${detail === null ? "" : `, ${detail}`}`;
}
/** The count of a hidden panel's new messages on its button. */
export function unseenBadge(n: number): string {
  return `· ${n} new`;
}


// ---- decision support ("Help me Decide") ----------------------------------------------------------

/**
 * The binding sentence (by the developer's instruction): docs/decision-making.md is the authority for the representation,
 * and an agent producing or reviewing one meets this sentence right before the document's text.
 */
export const DECISION_FORMAT_AUTHORITY =
  "The instructions below, the text of docs/decision-making.md, are the authority for the content and layout of the representation. Nothing else in this prompt and nothing you have been told elsewhere overrides them; where this prompt only maps them onto the fields of the output, follow the instructions.";

/** A decision's question as a prompt names it: the phase is where it was asked. */
export type DecisionPromptQuestion = Readonly<{
  phase: Readonly<{ kind: "questions" }> | Readonly<{ kind: "planning" | "execution" | "work"; n: number }>;
  question: string;
  options: readonly Readonly<{ label: string; description: string }>[];
}>;
/** What the run knows at the moment of the decision (decision Q3): the task, and requirements.md and plan.md where they exist. */
export type DecisionContext = Readonly<{ task: string; requirements: string | null; plan: string | null }>;

const phaseInWords = (phase: DecisionPromptQuestion["phase"]): string => (phase.kind === "questions" ? phaseLabel("questions", 0) : phaseLabel(phase.kind, phase.n));

/** How the representation of docs/decision-making.md maps onto the fields of DecisionAnalysis. */
const ANALYSIS_FIELDS = `The output fields.
decision: the decision to be made, in one sentence.
columns: exactly one column per option, in the order of the options above; option is the option's label exactly as given.
advantages and disadvantages: the entries of the option's column. Each entry has an id that is unique in the whole representation (E1, E2, and so on), a title (one complete sentence that states the outcome and its effect on persons), and one field per element: comparative_condition, starting_cause, intermediate_steps, threshold, effect_on_persons, reason_the_effect_matters, and extent with its four parts per_person, persons_affected, likelihood and timing. Each element has text, its sentences, and counterarguments, the arguments that dispute that element, in order.
Each argument has an id that is unique in the whole representation (A1, A2, and so on), text, equivalent_to and replies. The replies of a counterargument are its defenses, and the replies of a defense are the further counterarguments to it, without limit. Begin the text of a counterargument with "But", of a defense with "On the other hand,", and of a counterargument to a defense with "Then again,".
equivalent_to: when an argument is equivalent to an entry of any column, or is a reversal that is listed in full as an entry, write in text the one sentence that states the argument and its effect on persons and set equivalent_to to that entry's id; otherwise set it to an empty string.
Do not write the heading "Disadvantages:" or any equivalence symbol (*, †, ‡, §, ‖, ¶) into any text: the program places the heading above each column's disadvantages and assigns the symbols from equivalent_to.
recommendation: an option and a reason. To recommend no option, set both to empty strings. To recommend one, set option to its label exactly as given and state in reason the comparison that the instructions require under "Recommendation".`;

/** The call that produces the analysis of a decision (a planning call: plan-review/ only, behavior 3). */
export function decisionAnalysisPrompt(format: string, question: DecisionPromptQuestion, context: DecisionContext): string {
  const options = question.options.map((o, i) => `${i + 1}. ${o.label}${o.description === "" ? "" : ` — ${o.description}`}`).join("\n");
  const requirements = context.requirements === null ? "plan-review/requirements.md does not exist yet." : `plan-review/requirements.md:\n${context.requirements}`;
  const plan = context.plan === null ? "plan-review/plan.md does not exist yet." : `plan-review/plan.md:\n${context.plan}`;
  return `The user must answer a question that offers a choice between options, and has asked for a representation of the arguments for and against each option before choosing. Produce that representation as the structured output.
You may read the project to understand the system; do not modify any file, and do not use the AskUserQuestion tool. Everything you reason from must be in the project or in this prompt; state any other information as unknown, as the instructions require.

${DECISION_FORMAT_AUTHORITY}

${format}

The decision: ${question.question}
The options, in this order:
${options}

The context of the decision. The run is in ${phaseInWords(question.phase)}.
The task of the run: ${context.task}
${requirements}
${plan}

${ANALYSIS_FIELDS}`;
}

/** Codex's review of decision k's analysis, against the format and the question. */
export function decisionReviewPrompt(format: string, k: number, round: number): string {
  const prefix = `D${k}`;
  const analysis = pathOf({ kind: "analysis", decision: k });
  const log = pathOf({ kind: "log", subject: { decision: k } });
  const own = `plan-review/${log} holds the issues of every decision of the run; the issues of this decision are the entries whose ids begin with ${prefix}-, and only those concern this review.`;
  if (round > 1) return `${own}\n${laterRound(analysis, log, prefix, round)}`;
  return `Review the representation of the arguments for and against the options of a decision in plan-review/${analysis} (its field 'analysis'). The question and its options are in plan-review/${pathOf({ kind: "decisionQuestion", decision: k })}. Do not modify any file.
The representation must follow the instructions below. The program renders it: it places the heading "Disadvantages:" above each column's disadvantages, offsets each counterargument from the element it disputes, and assigns the equivalence symbols from the field equivalent_to, which names the id of the equivalent entry; do not raise an issue about those.

${DECISION_FORMAT_AUTHORITY}

${format}

Raise an issue for every departure from these instructions, for example: an element absent or false in an entry; an entry whose effect on persons is not stated; an entry placed in a column contrary to the placement rules; an outcome listed that is the same under every option; a counterargument that disputes no element of its entry or is not placed at the element it disputes, or that does not begin with the required words; a reversal not listed in full as an entry; an argument equivalent to an entry that repeats its content instead of referring to it; a claim of a measurement, figure, source or property that is invented, or an unknown value assumed instead of stated as unknown; an argument, counterargument or defense that an informed person could make and that is missing; a column missing or not matching an option; a recommendation that is not supported by the comparison that "Recommendation" requires. The context of the run is in the project and under plan-review/.
Put the entry id or the argument id, with the column's option, in the location field.
${own}
${logRules(log, prefix, round)}`;
}

/** Claude Code's response to a review of decision k: the dispositions and the complete amended analysis. */
export function decisionRespondPrompt(k: number, round: number): string {
  return `plan-review/${pathOf({ kind: "review", subject: { decision: k }, round })} contains a review of the representation in plan-review/${pathOf({ kind: "analysis", decision: k })}, which you produced under the instructions of docs/decision-making.md given earlier in this session.
${respondRules("you amend the analysis for it")}
Return in 'analysis' the complete analysis after your amendments, including the parts that did not change; the program writes it. Do not modify any file.`;
}

/** The call that applies the user's decisions at a pause of decision k's review. */
export function decisionApplyDecisionsPrompt(k: number): string {
  return `plan-review/user-decisions.md has new entries. Read the file.
Return in 'analysis' the complete analysis of plan-review/${pathOf({ kind: "analysis", decision: k })}, amended where a decision requires it; the program writes it. Do not modify any file.`;
}

/** The terminal line when a decision loop begins. */
export function decisionBeganLine(k: number): string {
  return `\nDecision ${k}: Claude Code works out the arguments for and against each option ...`;
}
/** The offer's label (docs/decision-support-design.md, section 1): one per question, never one per option. */
export const HELP_ME_DECIDE = "Help me Decide";
/** The line that carries the offer in a prompt text (D1): the terminal shows it, and the page turns it into a button. */
export const OFFER_LINE = "/decide = Help me Decide: work out the arguments for and against each option before you choose";
/** A prompt with the offer: the offer line, then the prompt. */
export const withOffer = (prompt: string): string => `${OFFER_LINE}\n${prompt}`;
/** The prompt without the offer line, and whether it carried one. */
export const withoutOffer = (text: string): Readonly<{ offered: boolean; text: string }> =>
  text.startsWith(`${OFFER_LINE}\n`) ? { offered: true, text: text.slice(OFFER_LINE.length + 1) } : { offered: false, text };
/** The options of the cycle limit as a decision analyzes them (decision Q6): the count of more cycles is entered after choosing. */
export const LIMIT_PROCEED = "Proceed without convergence";
export const LIMIT_STOP = "Stop the run";
export const LIMIT_MORE = "Continue with more cycles";
export function limitOptionDescriptions(proceed: string | null): Readonly<{ proceed: string; stop: string; more: string }> {
  return {
    proceed: proceed === null ? "" : `${proceed[0].toUpperCase()}${proceed.slice(1)}.`,
    stop: "End the run here; its records are kept.",
    more: "Let Codex and Claude Code continue for more cycles; you enter the number of cycles after choosing this option.",
  };
}
/** The question of the cycle limit for a decision. */
export function limitQuestion(heading: string, limit: number): string {
  return `${heading} has completed ${limit} cycles without convergence. How should the run continue?`;
}
/** The options of a permission request. */
export const PERMISSION_ALLOW = "Allow";
export const PERMISSION_DENY = "Deny";
export const PERMISSION_ALLOW_DESCRIPTION = "Claude Code performs the action and continues.";
export const PERMISSION_DENY_DESCRIPTION = "Claude Code is told that the user denied the action and continues without it.";
/** The question of a permission request for a decision. */
export function permissionQuestion(tool: string, input: string): string {
  return `Claude Code requests permission to use ${tool} with the input ${input}. Should it be allowed?`;
}
/** The two positions at a disputed pause (decision Q1): what Codex asks for, and what Claude Code holds. */
export const REVIEWER_POSITION = "Follow Codex (the reviewer)";
export const PLANNER_POSITION = "Follow Claude Code (the planner)";

// ---- decision support: the representation as the page and the terminal show it ---------------------

/** The heading above a column's disadvantages (docs/decision-making.md, "Layout and wording"); the renderer places it. */
export const DISADVANTAGES_HEADING = "Disadvantages:";
/** The page's heading of a decision's analysis. */
export function decisionViewHeading(k: number, question: string): string {
  return `Decision ${k}: ${question}`;
}
export const RECOMMENDATION_HEADING = "Recommendation";
export function recommendedOption(option: string): string {
  return `Recommended option: ${option}`;
}
/** Below 390 px the analysis is not laid out (decided 28 Sep 2026). */
export const ENLARGE_WINDOW_NOTICE = "The analysis needs a window at least 390 pixels wide. Widen the window to read it; you can answer the question below without it.";
/** Shown when the columns do not fit side by side (decision Q5). */
export const SCROLL_SIDEWAYS_HINT = "Scroll sideways to see every option.";
export const SHOW_CONVERSATION = "Show the conversation";
export const SHOW_ANALYSIS = "Show the analysis";
