// Prompt texts. All paths are relative to the project directory.

export function initialPlanPrompt(task: string): string {
  return `Produce an implementation plan for the task below. Investigate the codebase as needed.
Write the plan to plan-review/plan.md as numbered steps, each with a marker that shows whether the step is completed.
Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be written; otherwise return an empty array.
Task: ${task}`;
}

export const revisePlanPrompt = `Execution has stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop.
Revise plan-review/plan.md for the remaining work: keep the completed steps and their markers, and change, add, or remove remaining steps as the user's input and the current state of the codebase require.
If no change to the plan is required, leave the file unchanged. Do not modify any other file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.`;

export const applyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend plan-review/plan.md where a decision requires it. Do not modify any other file.
Return an empty questions_for_user array.`;

export function reviewPrompt(phase: number, round: number): string {
  const rules = `Review the implementation plan in plan-review/plan.md against the codebase. Do not modify any file.
Steps that the plan marks as completed are already implemented in the codebase; review the remaining steps, and review whether the remaining steps are consistent with the implemented state.
plan-review/issue-log.json lists every issue raised in earlier rounds and phases with the planner's disposition and rationale.
An entry with superseded = true has been replaced by a later entry with the same id; use the later entry.
Entries with source 'self_correction' record corrections that the planner made to its own earlier work.
The rationale of every entry is addressed to you; read it irrespective of the action.
An entry with action 'decided_by_user' contains a decision of the user on that issue, which must be followed.
plan-review/reviewer-feedback.md contains feedback from the planner that concerns no single issue; take it into account.
For an entry with action 'clarification_requested', the rationale contains a question to you: if the issue is valid, raise it again under the same id and answer the question in the evidence field; if the question shows the issue to be mistaken, omit the issue.
plan-review/user-decisions.md contains input and decisions by the user, which must be followed; do not raise an issue that contradicts them.
Do not repeat an issue whose action is 'accepted' unless the plan still contains the defect.
Do not repeat an issue whose action is 'rejected', 'no_change_needed', or 'partially_accepted', under the same or a different wording, unless you can state a specific error in the rationale; in that case reuse the original id and state the error in the evidence field.
Do not raise an issue whose correction would undo the correction made for an accepted issue in the log; if you consider an accepted correction wrong, reuse the id of that issue and state the error in the evidence field.
Severity: blocking = the plan cannot succeed as written; major = the plan will produce a defect or omits a required step; minor = everything else.
Return an empty issues array when no issue is found.`;
  const ids = `New issues receive ids of the form P${phase}-R${round}-1, P${phase}-R${round}-2, and so on.`;
  if (round === 1) return `${rules}\n${ids}`;
  return `The planner has answered your issues; the answers are in plan-review/issue-log.json, and plan-review/plan.md may have been amended.
Read both files again and review the plan again under the same rules as before. ${ids}`;
}

export function respondPrompt(phase: number, round: number): string {
  return `plan-review/planning-${phase}/review-${round}.json contains a review of plan-review/plan.md.
plan-review/user-decisions.md contains input and decisions by the user, which must be followed.
Evaluate each issue critically against the codebase; do not assume the reviewer is correct.
Choose one action for each issue.
'accepted': the issue is valid and you amend plan-review/plan.md for it.
'partially_accepted': a part of the issue is valid; amend the plan for that part and state in the rationale which part you do not accept and why.
'rejected': the issue is mistaken; no amendment.
'no_change_needed': the concern is valid, but the plan already satisfies it or it is outside the task; no amendment; state where the plan satisfies it or why it is outside the task.
'clarification_requested': you cannot evaluate the issue without an answer from the reviewer; no amendment; put the question in the rationale.
Every rationale is addressed to the reviewer and is returned to the reviewer irrespective of the action; use it for any feedback on the issue, including feedback on an accepted issue.
Put in reviewer_feedback any feedback to the reviewer that concerns no single issue, for example a wrong assumption that several issues share; otherwise return an empty string.
If an issue repeats an earlier issue under a different id, set duplicate_of to the earlier id; otherwise set it to an empty string.
If acting on an issue would undo a correction that you made for an earlier accepted issue, do not amend the plan for it: set action to 'rejected', set reverses to the id of the earlier issue, and explain the conflict in the rationale; the user will decide. Otherwise set reverses to an empty string.
Independently of the current issues: if you determine that one of your earlier dispositions, or a part of the plan, was wrong, report it in self_corrections with an explanation addressed to the reviewer.
Use new_action 'accepted' with the id of an issue that you rejected earlier and now accept; amend the plan for it.
Use new_action 'rejected' with the id of an accepted issue whose correction you now consider wrong; do not amend the plan for it, the user will decide.
Use new_action 'plan_error' with an empty id for an error that concerns no issue; amend the plan for it.
Return an empty self_corrections array when there is none.
Return exactly one disposition per issue id. Put in questions_for_user only questions that the user alone can answer.
Do not modify any file other than plan-review/plan.md.`;
}

export const executePrompt = `The plan in plan-review/plan.md has been reviewed. Implement its remaining steps in order.
After you complete a step, set its completion marker in plan-review/plan.md; do not change the content of the remaining steps.
If you need information or a decision from the user, or if a remaining step proves to be wrong, do not continue on an assumption: ask with the AskUserQuestion tool. After you have asked, make no further tool calls; end your turn with status 'needs_input'.
If you cannot continue for another reason, for example a command that fails and that you cannot correct or a denied permission, stop and return status 'blocked' with the description in the question field.
When every step is completed and verified, return status 'finished'.
In every case put a summary of the work done in summary and a description of the steps not yet completed in remaining_work.`;
