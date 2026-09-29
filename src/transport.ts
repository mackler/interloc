// The classification of the agents' failures (issue #26): the one place where an SDK's failure is inspected to decide
// whether a retry could fix it. Pure: no I/O, no Effect.

/**
 * What src/claudeEvents.ts keeps of a failed Claude Code call. The terminal facts (the result's status, reason and
 * subtype, the stream error's code) belong to the failure by construction; `assistantError` and `retrySeen` are only
 * what was seen after the last sign of progress.
 */
export type ClaudeFailure = Readonly<{
  streamCode: string | null;
  apiStatus: number | null;
  terminalReason: string | null;
  assistantError: string | null;
  retrySeen: Readonly<{ status: number | null; error: string }> | null;
  subtype: string | null;
}>;

/** The error codes of Node.js that name a dropped, refused or timed-out connection. */
export const NETWORK_CODES: readonly string[] = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"];

/** An HTTP status in a message: after "status", "HTTP" or "code", or before its reason phrase. */
const statusesIn = (message: string): readonly number[] =>
  [...message.matchAll(/\b(?:status(?: code)?|http(?:\/[\d.]+)?)\s*[:=]?\s*(\d{3})\b|\b(\d{3})\s+(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/gi)].map((m) =>
    Number(m[1] ?? m[2]),
  );

const codexPermanent = /usage limit|rate limit|quota|invalid_json_schema|outputSchema/i;
const codexTransport = /stream disconnected|connection reset|connection closed|timed out|timeout|WebSocket protocol error|Reconnecting|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN/i;

/** Whether a failed Codex turn, by its message, is a transport fault that a retry could fix; permanent evidence wins. */
export const classifyCodex = (message: string): boolean => {
  const statuses = statusesIn(message);
  if (codexPermanent.test(message) || statuses.some((s) => s >= 400 && s <= 499)) return false;
  return codexTransport.test(message) || statuses.some((s) => s >= 500 && s <= 599);
};

/** The assistant errors of the Agent SDK (SDKAssistantMessageError) that no retry fixes. */
export const PERMANENT_ASSISTANT_ERRORS: readonly string[] = [
  "rate_limit",
  "billing_error",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
  "cloud_credential_error",
];
const RETRYABLE_ASSISTANT_ERRORS: readonly string[] = ["server_error", "overloaded"];
const STOPPING_SUBTYPES: readonly string[] = ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"];
const is4xx = (s: number | null): boolean => s !== null && s >= 400 && s <= 499;
const is5xx = (s: number | null): boolean => s !== null && s >= 500 && s <= 599;

/**
 * Whether a failed Claude Code call, by the facts kept of it, is a transport fault that a retry could fix. Permanent
 * evidence is checked first; `terminalReason` alone is never sufficient.
 */
export const classifyClaude = (failure: ClaudeFailure | null): boolean => {
  if (failure === null) return false;
  const { streamCode, apiStatus, assistantError, retrySeen, subtype } = failure;
  const permanent =
    is4xx(apiStatus) ||
    (assistantError !== null && PERMANENT_ASSISTANT_ERRORS.includes(assistantError)) ||
    (retrySeen !== null && (is4xx(retrySeen.status) || PERMANENT_ASSISTANT_ERRORS.includes(retrySeen.error))) ||
    (subtype !== null && STOPPING_SUBTYPES.includes(subtype));
  if (permanent) return false;
  return (
    (streamCode !== null && NETWORK_CODES.includes(streamCode)) ||
    is5xx(apiStatus) ||
    (assistantError !== null && RETRYABLE_ASSISTANT_ERRORS.includes(assistantError)) ||
    (retrySeen !== null && (retrySeen.status === null || is5xx(retrySeen.status)))
  );
};
