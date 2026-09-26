import { describe, expect, test } from "vitest";
import { readRemembered, remember, type StorageLike } from "./storage.ts";

// Finding 3 of docs/gui-review.md: the storage edge returns typed results; nothing it does can throw.
const memory = (): StorageLike & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
};
const securityError = () => new DOMException("access denied", "SecurityError");

describe("storage", () => {
  test("a remembered path is read back; nothing remembered reads as the empty string", () => {
    const store = memory();
    expect(readRemembered(() => store)).toEqual({ ok: true, value: "" });
    expect(remember("/work/p", () => store)).toEqual({ ok: true, value: undefined });
    expect(readRemembered(() => store)).toEqual({ ok: true, value: "/work/p" });
  });

  test("a throwing acquisition, getItem or setItem, and absent storage, are failures, not exceptions", () => {
    const throwingGetter = () => {
      throw securityError();
    };
    expect(readRemembered(throwingGetter)).toEqual({ ok: false });
    expect(remember("/p", throwingGetter)).toEqual({ ok: false });
    expect(readRemembered(() => undefined)).toEqual({ ok: false });
    expect(remember("/p", () => undefined)).toEqual({ ok: false });
    const broken: StorageLike = {
      getItem: () => {
        throw securityError();
      },
      setItem: () => {
        throw securityError();
      },
    };
    expect(readRemembered(() => broken)).toEqual({ ok: false });
    expect(remember("/p", () => broken)).toEqual({ ok: false });
  });
});
