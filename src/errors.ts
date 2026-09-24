// Typed errors: one per cause that ends a run, and one per I/O or parse failure that used to escape
// raw. `describe` produces the text that the program prints. Replaces the single Halt class.
import { Data } from "effect";

export class UserStopped extends Data.TaggedError("UserStopped")<{ readonly where: string }> {}
export class ProjectChanged extends Data.TaggedError("ProjectChanged")<{ readonly during: "planning" | "review"; readonly fileLabel: string | null; readonly changes: string[] }> {}
export class ReviewedFileChanged extends Data.TaggedError("ReviewedFileChanged")<{ readonly fileLabel: string; readonly changes: string[] }> {}
export class PlanNotWritten extends Data.TaggedError("PlanNotWritten")<{ readonly file: string }> {}
export class AcceptedWithoutChange extends Data.TaggedError("AcceptedWithoutChange")<{ readonly fileLabel: string; readonly accepted: number }> {}
export class MissingDispositions extends Data.TaggedError("MissingDispositions")<{ readonly ids: string[] }> {}
export class RoundLimitStop extends Data.TaggedError("RoundLimitStop")<{ readonly heading: string }> {}
export class ClaudeCallFailed extends Data.TaggedError("ClaudeCallFailed")<{ readonly message: string }> {}
export class CodexCallFailed extends Data.TaggedError("CodexCallFailed")<{ readonly message: string }> {}
export class AgentReplyInvalid extends Data.TaggedError("AgentReplyInvalid")<{ readonly agent: string; readonly issue: string; readonly files: string[] }> {}
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{ readonly file: string; readonly path: string; readonly message: string }> {}
export class StateFileInvalid extends Data.TaggedError("StateFileInvalid")<{ readonly file: string; readonly message: string }> {}
export class FileSystemError extends Data.TaggedError("FileSystemError")<{ readonly operation: string; readonly path: string; readonly message: string }> {}
export class GitError extends Data.TaggedError("GitError")<{ readonly args: string[]; readonly message: string }> {}
export class Interrupted extends Data.TaggedError("Interrupted")<{ readonly where: string }> {}

export type RunError =
  | UserStopped
  | ProjectChanged
  | ReviewedFileChanged
  | PlanNotWritten
  | AcceptedWithoutChange
  | MissingDispositions
  | RoundLimitStop
  | ClaudeCallFailed
  | CodexCallFailed
  | AgentReplyInvalid
  | ConfigInvalid
  | StateFileInvalid
  | FileSystemError
  | GitError
  | Interrupted;

const indent = (changes: string[]): string => changes.map((line) => `\n  ${line}`).join("");

/** The text that the program prints for an error. */
export const describe = (error: RunError): string => {
  switch (error._tag) {
    case "UserStopped":
      return "stopped by the user";
    case "ProjectChanged":
      return error.during === "planning"
        ? `the project outside plan-review/ changed during a planning-phase call. Either Claude Code changed it, or another process did (for example another Claude Code session in the same project).${indent(error.changes)}`
        : `the project or ${error.fileLabel} changed during a Codex review. Either Codex changed it, or another process did.${indent(error.changes)}`;
    case "ReviewedFileChanged":
      return `the project or ${error.fileLabel} changed during a Codex review. Either Codex changed it, or another process did.${indent(error.changes)}`;
    case "PlanNotWritten":
      return `Claude Code did not write ${error.file}`;
    case "AcceptedWithoutChange":
      return `Claude Code accepted ${error.accepted} issues in full or in part but ${error.fileLabel} is unchanged`;
    case "MissingDispositions":
      return `Claude Code returned no disposition for: ${error.ids.join(", ")}`;
    case "RoundLimitStop":
      return `stopped by the user at the round limit of ${error.heading}`;
    case "ClaudeCallFailed":
      return `Claude Code planning call failed: ${error.message}`;
    case "CodexCallFailed":
      return `Codex review failed: ${error.message}`;
    case "AgentReplyInvalid":
      return `the reply of ${error.agent} does not match its schema: ${error.issue}. The reply is kept in ${error.files.join(", ")}`;
    case "ConfigInvalid":
      return `${error.file} is not a valid configuration: ${error.message} (at ${error.path})`;
    case "StateFileInvalid":
      return `${error.file} could not be read: ${error.message}`;
    case "FileSystemError":
      return `${error.operation} failed for ${error.path}: ${error.message}`;
    case "GitError":
      return `git ${error.args.join(" ")} failed: ${error.message}`;
    case "Interrupted":
      return `interrupted during ${error.where}`;
  }
};

const TAGS = new Set<string>([
  "UserStopped", "ProjectChanged", "ReviewedFileChanged", "PlanNotWritten", "AcceptedWithoutChange",
  "MissingDispositions", "RoundLimitStop", "ClaudeCallFailed", "CodexCallFailed", "AgentReplyInvalid",
  "ConfigInvalid", "StateFileInvalid", "FileSystemError", "GitError", "Interrupted",
]);

/**
 * What the entry point prints for an error, or null if the error is none of ours, in which case the
 * entry point rethrows it. Keeps that decision out of the untested main.ts.
 */
export const haltMessage = (error: unknown): string | null => {
  const tag: unknown = (error as { _tag?: unknown } | null)?._tag;
  if (typeof tag === "string" && TAGS.has(tag)) return `HALTED: ${describe(error as RunError)}`;
  return null;
};
