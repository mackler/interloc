// The page's connection to the server (plan step 4.3): one WebSocket, reconnected with exponential backoff
// (1 s to 30 s), and a queue of the page's actions while it is not connected. This module is an edge of the page:
// it holds the socket and the timers; what the messages mean is the reducer's (state.ts).

import { notSentNotice } from "../../src/prompts.ts";
import { type ClientMessage, decodeServer, type ServerMessage } from "../../src/protocol.ts";

/** The part of the browser's WebSocket this module uses; a test injects a fake. */
export type SocketLike = {
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type Environment = {
  open: (url: string) => SocketLike;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
export type Handlers = {
  onMessage: (message: ServerMessage) => void;
  onState: (state: "open" | "reconnecting") => void;
  /** An action of the page that was not sent, explained for the user. */
  onNotice: (text: string) => void;
};
export type Connection = { send: (message: ClientMessage) => void; reconnect: () => void; close: () => void };

/** The delay before the n-th reconnection attempt (from 1): 1 s, 2 s, 4 s, … at most 30 s. */
export const backoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

export const browserEnvironment = (): Environment => ({
  open: (url) => new WebSocket(url) as unknown as SocketLike,
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
});


export const connect = (url: string, handlers: Handlers, env: Environment = browserEnvironment()): Connection => {
  let socket: SocketLike | null = null;
  // Actions are sent only after the server's hello, so that one made for an ended run is not delivered to the next.
  let ready = false;
  let queue: ClientMessage[] = [];
  let attempt = 0;
  let timer: unknown = null;
  let closed = false;

  /** The queued actions after a hello: an answer or a stop of another incarnation or of an ended run is discarded with a notice (finding 12). */
  const flush = (hello: Readonly<{ current: number | null; incarnation: string }>) => {
    const pending = queue;
    queue = [];
    for (const m of pending) {
      if ((m.type === "answer" || m.type === "stop") && m.incarnation !== hello.incarnation) handlers.onNotice(notSentNotice(m.type, "restarted"));
      else if ((m.type === "answer" || m.type === "stop") && m.run !== hello.current) handlers.onNotice(notSentNotice(m.type, "ended"));
      else socket?.send(JSON.stringify(m));
    }
  };
  const schedule = () => {
    if (closed || timer !== null) return;
    attempt += 1;
    handlers.onState("reconnecting");
    timer = env.setTimeout(() => {
      timer = null;
      open();
    }, backoff(attempt));
  };
  const open = () => {
    ready = false;
    const s = env.open(url);
    socket = s;
    s.onmessage = (event) => {
      const decoded = decodeServer(String(event.data));
      if (decoded._tag !== "Success") return;
      if (decoded.success.type === "hello") {
        attempt = 0;
        ready = true;
        handlers.onState("open");
        handlers.onMessage(decoded.success);
        flush(decoded.success);
        return;
      }
      handlers.onMessage(decoded.success);
    };
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      ready = false;
      schedule();
    };
    s.onerror = () => s.close();
  };
  open();

  return {
    send: (m) => {
      if (ready && socket !== null) socket.send(JSON.stringify(m));
      else queue = [...queue, m];
    },
    /** A gap in the events: a new connection gives a fresh replay. */
    reconnect: () => {
      const s = socket;
      socket = null;
      ready = false;
      s?.close();
      open();
    },
    close: () => {
      closed = true;
      if (timer !== null) env.clearTimeout(timer);
      const s = socket;
      socket = null;
      s?.close();
    },
  };
};
