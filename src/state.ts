// The decoding of the program's own JSON records. The files themselves are read and written by the Store
// service (src/store.ts); the project snapshot is src/snapshot.ts.

import { Schema } from "effect";
import { StateFileInvalid } from "./errors.ts";
import { firstIssue } from "./schema.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parses JSON of one of the program's own records; a parse error is StateFileInvalid. */
export const parseJson = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new StateFileInvalid({ file, message: message(e) });
  }
};

/** Decodes parsed JSON of one of the program's own records; a mismatch is StateFileInvalid with the field path. */
export const decodeRecord = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out, json: unknown, options: { readonly onExcessProperty: "ignore" | "error" } = { onExcessProperty: "error" }): Out["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, options)(json);
  } catch (e) {
    if (!Schema.isSchemaError(e)) throw e;
    const { path: at, message: text } = firstIssue(e);
    throw new StateFileInvalid({ file, message: at === "" ? text : `${text} (at ${at})` });
  }
};
