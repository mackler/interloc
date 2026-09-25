// The project snapshot (decision Q1 of the functional design review): the working tree and the index per
// path, as git's porcelain v2 records plus the content of each listed working-tree entry. Pure: the store
// runs git and reads the files; this module decodes, compares and renders. Findings 1, 2, 26.

/** One record of `git status --porcelain=v2 -z`. Fields as git names them; paths are raw (never quoted). */
export type StatusRecord =
  | Readonly<{ kind: "changed"; xy: string; sub: string; mH: string; mI: string; mW: string; hH: string; hI: string; path: string }>
  | Readonly<{ kind: "renamed"; xy: string; sub: string; mH: string; mI: string; mW: string; hH: string; hI: string; score: string; path: string; origPath: string }>
  | Readonly<{ kind: "unmerged"; xy: string; sub: string; path: string }>
  | Readonly<{ kind: "untracked"; path: string }>;

/** What is at a path in the working tree. A link is the link itself, never its target's content. */
export type WorkingTreeEntry =
  | Readonly<{ type: "file"; hash: string }>
  | Readonly<{ type: "link"; target: string }>
  | Readonly<{ type: "directory" }>
  | Readonly<{ type: "missing" }>;

export type SnapshotEntry = Readonly<{ record: StatusRecord; content: WorkingTreeEntry }>;
export type Snapshot = Readonly<{ entries: ReadonlyMap<string, SnapshotEntry> }>;

export type Change = Readonly<{ kind: "added" | "removed" | "content_changed" | "type_changed" | "status_changed"; path: string; from?: string; to?: string }>;

// The record formats of porcelain v2 (git-status(1)). With -z every entry ends with NUL and a rename or copy
// entry is followed by the original path as its own entry. A path is the rest of the entry: it may contain
// spaces and newlines, hence the `s` flag.
const CHANGED = /^1 (\S\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s;
const RENAMED = /^2 (\S\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s;
const UNMERGED = /^u (\S\S) (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s;
const UNTRACKED = /^\? (.*)$/s;

/** The records of the NUL-delimited porcelain v2 output. Total: entries of other kinds are skipped. */
export const decodeStatusV2 = (nulText: string): readonly StatusRecord[] => {
  const entries = nulText.split("\0").filter((e) => e !== "");
  const records: StatusRecord[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let m: RegExpMatchArray | null;
    if ((m = CHANGED.exec(entry)) !== null) {
      records.push({ kind: "changed", xy: m[1], sub: m[2], mH: m[3], mI: m[4], mW: m[5], hH: m[6], hI: m[7], path: m[8] });
    } else if ((m = RENAMED.exec(entry)) !== null) {
      records.push({ kind: "renamed", xy: m[1], sub: m[2], mH: m[3], mI: m[4], mW: m[5], hH: m[6], hI: m[7], score: m[8], path: m[9], origPath: entries[++i] ?? "" });
    } else if ((m = UNMERGED.exec(entry)) !== null) {
      records.push({ kind: "unmerged", xy: m[1], sub: m[2], path: m[3] });
    } else if ((m = UNTRACKED.exec(entry)) !== null) {
      records.push({ kind: "untracked", path: m[1] });
    }
  }
  return records;
};

const statusOf = (record: StatusRecord): string => (record.kind === "untracked" ? "??" : `${record.kind}:${record.xy}`);
const contentKey = (content: WorkingTreeEntry): string => (content.type === "file" ? content.hash : content.type === "link" ? content.target : "");

/** The differences between two snapshots, one per path, in path order. Empty means no change. */
export const compareSnapshots = (before: Snapshot, after: Snapshot): readonly Change[] => {
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
  const changes: Change[] = [];
  for (const path of paths) {
    const b = before.entries.get(path);
    const a = after.entries.get(path);
    if (b === undefined) changes.push({ kind: "added", path });
    else if (a === undefined) changes.push({ kind: "removed", path });
    else if (statusOf(b.record) !== statusOf(a.record)) changes.push({ kind: "status_changed", path, from: statusOf(b.record), to: statusOf(a.record) });
    else if (b.content.type !== a.content.type) changes.push({ kind: "type_changed", path, from: b.content.type, to: a.content.type });
    else if (contentKey(b.content) !== contentKey(a.content)) changes.push({ kind: "content_changed", path });
  }
  return changes;
};

export const renderChange = (change: Change): string =>
  `${change.kind.replace("_", " ")}: ${change.path}${change.from !== undefined || change.to !== undefined ? ` (${change.from ?? "?"} -> ${change.to ?? "?"})` : ""}`;

/** Paths the change detection does not observe: the program's own records and the configured ignorePaths. */
export const excluded = (path: string, ignorePaths: readonly string[]): boolean =>
  path.startsWith("plan-review/") ||
  ignorePaths.some((p) => {
    const prefix = p.endsWith("/") ? p.slice(0, -1) : p;
    return path === prefix || path.startsWith(`${prefix}/`);
  });
