// Prompt texts. All paths are relative to the project directory.

const SEVERITY = `Severity: blocking = the work cannot succeed with the file as written; major = the file as written will produce a defect or omits something required; minor = everything else.`;

/** Rules for the use of an issue log. They are the same for every reviewed file. */
function logRules(logFile: string, idPrefix: string, round: number): string {
  return `plan-review/${logFile} lists every issue raised in earlier rounds with the planner's disposition and rationale.
An entry with superseded = true has been replaced by a later entry with the same id; use the later entry.
Entries with source 'self_correction' record corrections that the planner made to its own earlier work.
The rationale of every entry is addressed to you; read it irrespective of the action.
An entry with action 'decided_by_user' contains a decision of the user on that issue, which must be followed.
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
  if (round > 1) return laterRound("questions.json", "questions-log.json", "Q", round);
  return `Review the question list in plan-review/questions.json against the task text in the same file and against the codebase. Do not modify any file.
The planner will ask the user these questions in an interview and will then write an implementation plan from the answers.
Raise an issue when: a question whose answer the plan needs is missing; a question is unnecessary because the task text or the codebase determines the answer (name the file); a question is ambiguous or combines several decisions; a reason is wrong; a feasible answer is missing from the proposed answers, or a proposed answer is not feasible in this codebase; a default contradicts the task or the codebase.
Put the question id, or 'list' for an issue that concerns the list as a whole, in the location field.
${logRules("questions-log.json", "Q", round)}`;
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
Each of your turns produces these output fields. message_to_user: the text that the program shows to the user; plain text without Markdown tables. answered_ids: the ids of the agreed questions that the user has answered so far. complete: true only when every agreed question has been answered and you need nothing further from the user. summary: an empty string while complete is false.
When complete is true, summary contains the complete requirements document in Markdown: the task; every decision with the id of its question; the further information and constraints that the user gave; and open points, each with the default that will be assumed.
Ask one question per message. For an agreed question, show the proposed answers with numbers, name the default, and state the reason in one sentence. The user may answer with a number, a label, or free text.
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
Conduct a second interview with the user on those points only. Treat each accepted issue as an agreed question; use the issue ids in answered_ids.
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
  if (round > 1) return laterRound("requirements.md", "requirements-log.json", "G", round);
  return `Review plan-review/requirements.md. It is the result of an interview between the planner and the user, confirmed by the user. plan-review/questions.json contains the task and the questions that were agreed before the interview. Do not modify any file.
The planner will write an implementation plan from the task and this file.
Raise an issue when: an agreed question has no clear answer in the file; two statements in the file contradict each other; a statement cannot be followed in this codebase (name the file); a decision that the plan needs is still absent.
Put the question id or the heading in the location field.
${logRules("requirements-log.json", "G", round)}`;
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
Task: ${task}`;
}

export const revisePlanPrompt = `Execution has stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop.
Revise plan-review/plan.md for the remaining work: keep the completed steps and their markers, and change, add, or remove remaining steps as the user's input and the current state of the codebase require.
If no change to the plan is required, leave the file unchanged. Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.`;

export const planApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend plan-review/plan.md where a decision requires it. Do not modify any other file.
Return an empty questions_for_user array.`;

export function planReviewPrompt(phase: number, round: number, withRequirements: boolean): string {
  const prefix = `P${phase}`;
  if (round > 1) return laterRound("plan.md", "issue-log.json", prefix, round);
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions. It must be followed; raise an issue when a plan step contradicts it or omits something it requires.\n"
    : "";
  return `Review the implementation plan in plan-review/plan.md against the codebase. Do not modify any file.
${requirements}Steps that the plan marks as completed are already implemented in the codebase; review the remaining steps, and review whether the remaining steps are consistent with the implemented state.
Put the step number or the heading in the location field.
${logRules("issue-log.json", prefix, round)}`;
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
