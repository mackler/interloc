import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ServerMessage } from "../../src/protocol.ts";
import { backoff, connect, type Environment, type SocketLike } from "./socket.ts";

// Plan step 4.3: reconnection with backoff, replay on reconnect, and the queue of actions while disconnected.
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  // The server's side.
  open() {
    this.onopen?.({});
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.onclose?.({});
  }
}

let sockets: FakeSocket[] = [];
const env = (): Environment => ({
  open: () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  },
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
const handlers = () => ({ messages: [] as ServerMessage[], states: [] as string[], notices: [] as string[] });
const wire = (h: ReturnType<typeof handlers>) => ({ onMessage: (m: ServerMessage) => void h.messages.push(m), onState: (s: string) => void h.states.push(s), onNotice: (t: string) => void h.notices.push(t) });

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("socket", () => {
  test("a dropped connection is reopened after 1 s, 2 s, 4 s …, at most 30 s; a hello resets the backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    sockets[0].drop();
    expect(h.states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(2);
    sockets[1].drop();
    vi.advanceTimersByTime(1999);
    expect(sockets.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(3);
    sockets[2].open();
    sockets[2].receive({ type: "hello", cwd: "/", current: null });
    expect(h.states.at(-1)).toBe("open");
    sockets[2].drop();
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(4);
  });

  test("the replay after a reconnection reaches the page", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    sockets[0].drop();
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    sockets[1].receive({ type: "hello", cwd: "/", current: 1 });
    sockets[1].receive({ type: "replay", runs: [{ id: 1, events: [] }] });
    expect(h.messages.map((m) => m.type)).toEqual(["hello", "replay"]);
  });

  test("an answer queued while disconnected is sent after the hello when its run is still current", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    c.send({ type: "answer", run: 1, prompt: 3, text: "y" });
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sent, "flushed before the hello").toEqual([]);
    sockets[0].receive({ type: "hello", cwd: "/", current: 1 });
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([{ type: "answer", run: 1, prompt: 3, text: "y" }]);
    c.send({ type: "list", path: "/" });
    expect(sockets[0].sent.length).toBe(2);
  });

  test("a stop queued for a run that has ended by the reconnection is discarded with a notice", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].open();
    sockets[0].receive({ type: "hello", cwd: "/", current: 1 });
    sockets[0].drop();
    c.send({ type: "stop", run: 1 });
    c.send({ type: "start", project: "/p", task: "t" });
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    sockets[1].receive({ type: "hello", cwd: "/", current: null });
    expect(sockets[1].sent.map((s) => JSON.parse(s).type)).toEqual(["start"]);
    expect(h.notices).toEqual(["Stop was not sent: the run has ended."]);
  });
});
