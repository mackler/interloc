import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClaudeFailure, classifyClaude, classifyCodex } from "../src/transport.ts";

// Issue #26: only positive transport evidence belonging to the failure is retried, and known permanent evidence wins.

const issue26 = "Reconnecting... 2/5 (stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake)";

test("Codex: the message of #26 is a transport fault", () => {
  assert.equal(classifyCodex(issue26), true);
});

test("Codex: transport patterns are retried", () => {
  for (const m of ["stream disconnected before completion", "read ECONNRESET", "connect ETIMEDOUT 1.2.3.4:443", "socket hang up", "request timed out", "unexpected status 503 Service Unavailable", "getaddrinfo EAI_AGAIN api.openai.com", "connection closed before message completed"]) {
    assert.equal(classifyCodex(m), true, m);
  }
});

test("Codex: permanent evidence is not retried, and wins over transport evidence", () => {
  for (const m of ["You've hit your usage limit. Upgrade to Pro", "rate limit reached", "exceeded your current quota", "unexpected status 400 Bad Request: invalid_json_schema", "Invalid outputSchema", "unexpected status 401 Unauthorized", "stream disconnected: unexpected status 429 Too Many Requests"]) {
    assert.equal(classifyCodex(m), false, m);
  }
});

test("Codex: an unrecognized failure is not retried", () => {
  assert.equal(classifyCodex("something went wrong"), false);
  assert.equal(classifyCodex("no reply"), false);
});

test("Codex: an exec exit is retried only when its stderr shows a transport fault and nothing permanent", () => {
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: stream disconnected before completion"), true);
  assert.equal(classifyCodex("Codex Exec exited with code 1: error: unknown flag"), false);
  assert.equal(classifyCodex("Codex Exec exited with code 1: stream disconnected; usage limit"), false);
});

const none: ClaudeFailure = { streamCode: null, apiStatus: null, terminalReason: null, assistantError: null, retrySeen: null, subtype: null };
const f = (over: Partial<ClaudeFailure>): ClaudeFailure => ({ ...none, ...over });

test("Claude: no facts, or api_error without a status or other evidence, is not retried", () => {
  assert.equal(classifyClaude(null), false);
  assert.equal(classifyClaude(none), false);
  assert.equal(classifyClaude(f({ terminalReason: "api_error" })), false);
});

test("Claude: api_error with 400 is not retried, with 503 it is", () => {
  assert.equal(classifyClaude(f({ terminalReason: "api_error", apiStatus: 400 })), false);
  assert.equal(classifyClaude(f({ terminalReason: "api_error", apiStatus: 503 })), true);
});

test("Claude: a stream error with a network code is retried", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"]) assert.equal(classifyClaude(f({ streamCode: code })), true, code);
  assert.equal(classifyClaude(f({ streamCode: "ERR_SOMETHING" })), false);
});

test("Claude: server_error with status 401 is not retried: permanent evidence wins", () => {
  assert.equal(classifyClaude(f({ assistantError: "server_error", apiStatus: 401 })), false);
});

test("Claude: an assistant server_error or overloaded with no progress after it is retried", () => {
  assert.equal(classifyClaude(f({ assistantError: "server_error" })), true);
  assert.equal(classifyClaude(f({ assistantError: "overloaded" })), true);
});

test("Claude: permanent assistant errors are not retried, even with a network code", () => {
  for (const e of ["rate_limit", "billing_error", "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "invalid_request", "model_not_found", "max_output_tokens", "cloud_credential_error"]) {
    assert.equal(classifyClaude(f({ assistantError: e, streamCode: "ECONNRESET" })), false, e);
  }
});

test("Claude: an api_retry with status null or 5xx, and no progress after it, is retried", () => {
  assert.equal(classifyClaude(f({ retrySeen: { status: null, error: "unknown" } })), true);
  assert.equal(classifyClaude(f({ retrySeen: { status: 503, error: "server_error" } })), true);
});

test("Claude: an api_retry with a 4xx status or a permanent error wins over a network code (P1-R1-2)", () => {
  assert.equal(classifyClaude(f({ retrySeen: { status: 429, error: "rate_limit" }, streamCode: "ECONNRESET" })), false);
  assert.equal(classifyClaude(f({ retrySeen: { status: null, error: "rate_limit" }, streamCode: "ECONNRESET" })), false);
});

test("Claude: the stopping subtypes are not retried", () => {
  for (const s of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
    assert.equal(classifyClaude(f({ subtype: s, streamCode: "ECONNRESET" })), false, s);
  }
});
