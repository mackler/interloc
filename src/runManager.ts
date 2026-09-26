// The run manager of the web GUI (plan step 3.3): one run at a time, started, answered and stopped from the page;
// the events of the current run and of the last finished one, broadcast to every connected tab.

import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Ref, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Platform } from "./platform.ts";
import { exitCodeOf, program, type Wiring } from "./program.ts";
import type { RunEvent, RunRecord } from "./protocol.ts";
import { makeWebUi, type WebUi } from "./webUi.ts";

/** One event of a run as it is broadcast: the run's id and the event's sequence number in that run (from 0). */
export type Broadcast = Readonly<{ run: number; seq: number; event: RunEvent }>;
/** Why an action of the page was not carried out; shown to the user. */
export type Refusal = Readonly<{ refused: string }>;

export type RunManager = Readonly<{
  /** The server's working directory: where the page's directory browser starts. */
  cwd: string;
  /** Registers a listener for every event appended from now on, until the scope closes. */
  subscribe: (listener: (event: Broadcast) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
  /** The last finished run and the current one, as far as they exist, with all their events. */
  replay: Effect.Effect<readonly RunRecord[]>;
  /** The id of the run in progress, or null. */
  current: Effect.Effect<number | null>;
  /** Starts a run of the program in the project with the task; its id, or why not. */
  start: (project: string, task: string) => Effect.Effect<number | Refusal>;
  /** Interrupts the run with that id, like Ctrl+C (behaviour 11). */
  stop: (run: number) => Effect.Effect<Refusal | null>;
  /** The answer to a pending prompt of the run with that id. */
  answer: (run: number, prompt: number, text: string) => Effect.Effect<Refusal | null>;
}>;

type Run = Readonly<{ id: number; events: readonly RunEvent[]; ui: WebUi; fiber: Fiber.Fiber<number> | null }>;
type State = Readonly<{ nextId: number; current: Run | null; last: Run | null }>;
const record = (r: Run): RunRecord => ({ id: r.id, events: r.events });
const ENDED: Refusal = { refused: "that run has ended" };

/**
 * The manager over a wiring per run (the live one of main.ts with the run's web Ui). The state is one Ref: the
 * next id (never reused while the process lives), the current run and the last finished one. An event is
 * appended in one step with its seq and then broadcast, so a listener registered before a snapshot sees every
 * event that the snapshot does not hold (P1-R1-2).
 */
export const makeRunManager = (wiring: (ui: WebUi) => Wiring, cwd: string): Effect.Effect<RunManager, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const state = yield* Ref.make<State>({ nextId: 1, current: null, last: null });
    const listeners = yield* Ref.make<ReadonlySet<(event: Broadcast) => Effect.Effect<void>>>(new Set());

    const broadcast = (event: Broadcast) => Ref.get(listeners).pipe(Effect.flatMap((set) => Effect.forEach([...set], (listener) => listener(event), { discard: true })));
    /** Appends an event to the current run with the given id and broadcasts it; nothing when that run is not current. */
    const append = (id: number, event: RunEvent): Effect.Effect<void> =>
      Ref.modify(state, (s): readonly [Broadcast | null, State] => {
        if (s.current === null || s.current.id !== id) return [null, s];
        return [{ run: id, seq: s.current.events.length, event }, { ...s, current: { ...s.current, events: [...s.current.events, event] } }];
      }).pipe(Effect.flatMap((b) => (b === null ? Effect.void : broadcast(b))));

    /** Why the path cannot be a project, or null: it must be a directory in a git repository. */
    const invalidProject = (project: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const info = yield* Effect.exit(fs.stat(project));
        if (Exit.isFailure(info)) return `${project} does not exist or cannot be read`;
        if (info.value.type !== "Directory") return `${project} is not a directory`;
        const code = yield* Effect.scoped(
          spawner.spawn(ChildProcess.make("git", ["-C", project, "rev-parse", "--git-dir"])).pipe(Effect.flatMap((handle) => handle.exitCode)),
        ).pipe(Effect.catch(() => Effect.succeed(-1)));
        return code === 0 ? null : `${project} is not a git repository`;
      });

    /** The run with that id, if it is the current one. */
    const currentRun = (id: number) => Ref.get(state).pipe(Effect.map((s) => (s.current !== null && s.current.id === id ? s.current : null)));

    const start = (project: string, task: string): Effect.Effect<number | Refusal> =>
      Effect.gen(function* () {
        const invalid = yield* invalidProject(project);
        if (invalid !== null) return { refused: invalid };
        const gate = yield* Deferred.make<void>();
        // The ui's sink needs the id, and the id is taken with the reservation of the run.
        const idRef = yield* Ref.make(0);
        const ui = yield* makeWebUi((event) => Ref.get(idRef).pipe(Effect.flatMap((id) => append(id, event))));
        const reserved = yield* Ref.modify(state, (s): readonly [number | null, State] =>
          s.current !== null ? [null, s] : [s.nextId, { ...s, nextId: s.nextId + 1, current: { id: s.nextId, events: [], ui, fiber: null } }],
        );
        if (reserved === null) return { refused: "a run is in progress; stop it or wait for its end" };
        const id = reserved;
        yield* Ref.set(idRef, id);
        yield* append(id, { _tag: "Started", project, task, time: new Date(yield* Clock.currentTimeMillis).toISOString() });
        const finish = (exit: Exit.Exit<number>) =>
          append(id, { _tag: "Ended", code: exitCodeOf(exit) }).pipe(
            Effect.andThen(Ref.update(state, (s) => (s.current !== null && s.current.id === id ? { ...s, current: null, last: s.current } : s))),
          );
        // The fiber outlives the request that started it; it waits for the gate so that stop finds it.
        const fiber = yield* Deferred.await(gate).pipe(
          Effect.andThen(Effect.scoped(program([task, project], wiring(ui)))),
          Effect.onExit(finish),
          // Started at once, so that its onExit is in place before any stop can interrupt it.
          Effect.forkDetach({ startImmediately: true }),
        );
        yield* Ref.update(state, (s) => (s.current !== null && s.current.id === id ? { ...s, current: { ...s.current, fiber } } : s));
        yield* Deferred.succeed(gate, undefined);
        return id;
      });

    return {
      cwd,
      subscribe: (listener) =>
        Effect.acquireRelease(
          Ref.update(listeners, (set) => new Set([...set, listener])),
          () => Ref.update(listeners, (set) => new Set([...set].filter((l) => l !== listener))),
        ).pipe(Effect.asVoid),
      replay: Ref.get(state).pipe(Effect.map((s) => [s.last, s.current].flatMap((r) => (r === null ? [] : [record(r)])))),
      current: Ref.get(state).pipe(Effect.map((s) => s.current?.id ?? null)),
      start,
      stop: (id) =>
        currentRun(id).pipe(
          Effect.flatMap((r) => {
            if (r === null) return Effect.succeed(ENDED);
            if (r.fiber === null) return Effect.succeed<Refusal>({ refused: "the run is starting; try again" });
            return Fiber.interrupt(r.fiber).pipe(Effect.as(null));
          }),
        ),
      answer: (id, prompt, text) =>
        currentRun(id).pipe(
          Effect.flatMap((r) => {
            if (r === null) return Effect.succeed(ENDED);
            return r.ui.answer(prompt, text).pipe(Effect.map((taken): Refusal | null => (taken ? null : { refused: "that question has already been answered" })));
          }),
        ),
    };
  });
