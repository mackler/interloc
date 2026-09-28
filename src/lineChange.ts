// What the program measures of the reviewed file during a response (issue #31). Pure.

/** Whether the text changed at all, and the numbers of lines added and removed. */
export type FileChange = Readonly<{ changed: boolean; added: number; removed: number }>;

/** The lines of a text; a trailing newline ends the last line and does not begin another. */
const linesOf = (text: string): readonly string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

/**
 * The length of the shortest edit script (insertions plus deletions) from a to b: Myers' O(ND) algorithm, iterative so
 * that it is stack safe on any file. The working array is local to the call and never escapes it.
 */
const editDistance = (a: readonly string[], b: readonly string[]): number => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return 0;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return max;
};

/** The change from one text to another: `changed` compares the texts themselves, as the hash comparison does. */
export const lineChange = (before: string, after: string): FileChange => {
  if (before === after) return { changed: false, added: 0, removed: 0 };
  const a = linesOf(before);
  const b = linesOf(after);
  // The common prefix and suffix need no search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const common = (midA.length + midB.length - editDistance(midA, midB)) / 2;
  return { changed: true, added: midB.length - common, removed: midA.length - common };
};
