// The classification of one call of the schema acceptance prototype (finding 32 of
// docs/functional-design-review.md): a call counts as accepted only when the transport accepted the
// schema and the reply decoded. Pure; tested by test/classify.test.ts.

export type Transport = "accepted" | "rejected" | "timeout";
export type Classification = "accepted" | "accepted_undecodable" | "rejected" | "timeout";

export const classify = (transport: Transport, decoded: boolean): Classification => (transport === "accepted" ? (decoded ? "accepted" : "accepted_undecodable") : transport);
/** Only a call whose reply decoded is counted as accepted. */
export const counted = (classification: Classification): boolean => classification === "accepted";
