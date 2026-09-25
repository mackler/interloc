// The decoding of the program's own JSON records. The files themselves are read and written by the Store
// service (src/store.ts); the project snapshot is src/snapshot.ts. The decoders return a Result: a
// failure is a value, never a throw (finding 10 of docs/functional-design-review.md).

import { Result, Schema } from "effect";
import { StateFileInvalid } from "./errors.ts";
import { firstIssue } from "./schema.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parses JSON of one of the program's own records; a parse error is StateFileInvalid. */
export const parseJson = (file: string, text: string): Result.Result<unknown, StateFileInvalid> => {
  try {
    return Result.succeed(JSON.parse(text));
  } catch (e) {
    return Result.fail(new StateFileInvalid({ file, message: message(e) }));
  }
};

/** Decodes parsed JSON of one of the program's own records; a mismatch is StateFileInvalid with the field path. */
export const decodeRecord = <Out extends Schema.ConstraintDecoder<unknown>>(
  file: string,
  schema: Out,
  json: unknown,
  options: { readonly onExcessProperty: "ignore" | "error" } = { onExcessProperty: "error" },
): Result.Result<Out["Type"], StateFileInvalid> => {
  const decoded = Schema.decodeUnknownResult(schema, options)(json);
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success);
  const { path: at, message: text } = firstIssue(decoded.failure);
  return Result.fail(new StateFileInvalid({ file, message: at === "" ? text : `${text} (at ${at})` }));
};

/** Parses and decodes the text of one record. */
export const decodeText = <Out extends Schema.ConstraintDecoder<unknown>>(
  file: string,
  schema: Out,
  text: string,
  options?: { readonly onExcessProperty: "ignore" | "error" },
): Result.Result<Out["Type"], StateFileInvalid> => {
  const json = parseJson(file, text);
  return Result.isSuccess(json) ? decodeRecord(file, schema, json.success, options) : Result.fail(json.failure);
};
