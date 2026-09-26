// The web server (plan step 3.4): the built page from web/dist, and one WebSocket per tab: on connect the hello
// and the replay, then the live events; from the page start, answer, stop and list.

import { Effect, Exit, FileSystem, Path, Queue, type Scope } from "effect";
import { HttpPlatform, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { Socket } from "effect/unstable/socket";
import { type ClientMessage, decodeClient, inSnapshot, type ServerMessage } from "./protocol.ts";
import type { Broadcast, Refusal, RunManager } from "./runManager.ts";

/** What the server's handler needs besides the request. */
export type WebServerServices = HttpServerRequest.HttpServerRequest | Scope.Scope | HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path;

const notFound = HttpServerResponse.text("not found", { status: 404 });

/** The handler of every request. */
export const makeWebServer = (manager: RunManager, distDir: string): Effect.Effect<HttpServerResponse.HttpServerResponse, never, WebServerServices> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const url = new URL(request.url, "http://localhost");
    if (request.method !== "GET") return notFound;
    if (url.pathname === "/ws") {
      const socket = yield* request.upgrade.pipe(Effect.option);
      if (socket._tag === "None") return HttpServerResponse.text("a WebSocket upgrade was expected", { status: 400 });
      yield* session(manager, socket.value, fs, path);
      return HttpServerResponse.empty();
    }
    // The page: index.html at /, and the build's files; a path that leaves the build is not found.
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const root = path.resolve(distDir);
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return notFound;
    const info = yield* Effect.exit(fs.stat(file));
    if (Exit.isFailure(info) || info.value.type !== "File") return notFound;
    return yield* HttpServerResponse.file(file).pipe(Effect.catch(() => Effect.succeed(notFound)));
  });

/**
 * One tab's connection. The listener is registered first and buffers into a queue; then the snapshot is taken;
 * then hello and replay are written, and every buffered and later event except those the snapshot holds
 * (inSnapshot, a boundary per replayed run). The frames of the page are handled in order until the socket closes.
 */
const session = (manager: RunManager, socket: Socket.Socket, fs: FileSystem.FileSystem, path: Path.Path): Effect.Effect<void, never, Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      // The upgrade is accepted when the reader is acquired, and a write waits for that (Socket.fromWebSocket):
      // the reader comes first.
      const reader = yield* socket.reader.pipe(Effect.option);
      if (reader._tag === "None") return;
      const writer = yield* socket.writer;
      const send = (message: ServerMessage) => writer.write(JSON.stringify(message)).pipe(Effect.ignore);
      const buffered = yield* Queue.unbounded<Broadcast>();
      yield* manager.subscribe((event) => Queue.offer(buffered, event).pipe(Effect.asVoid));
      const runs = yield* manager.replay;
      yield* send({ type: "hello", cwd: manager.cwd, current: yield* manager.current });
      yield* send({ type: "replay", runs });
      const forward = Effect.gen(function* () {
        for (;;) {
          const event = yield* Queue.take(buffered);
          if (!inSnapshot(runs, event)) yield* send({ type: "event", run: event.run, seq: event.seq, event: event.event });
        }
      });
      yield* Effect.forkScoped(forward);

      const refuse = (r: Refusal | null) => (r === null ? Effect.void : send({ type: "refused", reason: r.refused }));
      const dispatch = (message: ClientMessage): Effect.Effect<void, never, Scope.Scope> => {
        switch (message.type) {
          case "start":
            return manager.start(message.project, message.task).pipe(Effect.flatMap((r) => (typeof r === "number" ? Effect.void : refuse(r))));
          case "answer":
            return manager.answer(message.run, message.prompt, message.text).pipe(Effect.flatMap(refuse));
          case "stop":
            // The interruption waits for the run's finalizers; the connection keeps reading meanwhile.
            return Effect.forkScoped(manager.stop(message.run).pipe(Effect.flatMap(refuse))).pipe(Effect.asVoid);
          case "list":
            return listing(message.path, fs, path).pipe(Effect.flatMap(send));
        }
      };
      // Every termination of the socket is a SocketError (Socket.d.ts); it ends the loop.
      yield* Effect.gen(function* () {
        for (;;) {
          for (const chunk of yield* reader.value.pull) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const decoded = decodeClient(text);
            yield* decoded._tag === "Success" ? dispatch(decoded.success) : send({ type: "refused", reason: `not a message: ${decoded.failure}` });
          }
        }
      }).pipe(Effect.ignore);
    }),
  );

/** The subdirectories of a directory, sorted, with its parent (null at the root); an error names the failure. */
const listing = (dir: string, fs: FileSystem.FileSystem, path: Path.Path): Effect.Effect<ServerMessage> =>
  Effect.gen(function* () {
    const resolved = path.resolve(dir);
    const parent = path.dirname(resolved) === resolved ? null : path.dirname(resolved);
    const names = yield* Effect.exit(fs.readDirectory(resolved));
    if (Exit.isFailure(names)) return { type: "listing", path: resolved, parent, dirs: [], error: `${resolved} cannot be listed` } as const;
    const dirs: string[] = [];
    for (const name of names.value) {
      const info = yield* Effect.exit(fs.stat(path.join(resolved, name)));
      if (Exit.isSuccess(info) && info.value.type === "Directory") dirs.push(name);
    }
    return { type: "listing", path: resolved, parent, dirs: dirs.sort(), error: null } as const;
  });
