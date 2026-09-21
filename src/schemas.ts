// JSON Schemas for the structured output of each agent call.

export const reviewSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          plan_section: { type: "string" },
          problem: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["id", "severity", "plan_section", "problem", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

export const plannerResponseSchema = {
  type: "object",
  properties: {
    dispositions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: {
            type: "string",
            enum: ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"],
          },
          rationale: { type: "string" },
          duplicate_of: { type: "string" },
          reverses: { type: "string" },
        },
        required: ["id", "action", "rationale", "duplicate_of", "reverses"],
      },
    },
    self_corrections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          new_action: { type: "string", enum: ["accepted", "rejected", "plan_error"] },
          explanation: { type: "string" },
        },
        required: ["id", "new_action", "explanation"],
      },
    },
    reviewer_feedback: { type: "string" },
    questions_for_user: { type: "array", items: { type: "string" } },
  },
  required: ["dispositions", "self_corrections", "reviewer_feedback", "questions_for_user"],
};

export const planWriteSchema = {
  type: "object",
  properties: { questions_for_user: { type: "array", items: { type: "string" } } },
  required: ["questions_for_user"],
};

export const execReportSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["finished", "needs_input", "blocked"] },
    summary: { type: "string" },
    question: { type: "string" },
    remaining_work: { type: "string" },
  },
  required: ["status", "summary", "question", "remaining_work"],
};
