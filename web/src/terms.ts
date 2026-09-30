// The terms of a question marked in its rendered HTML (S28, issue #36, decision Q5): every case-sensitive, whole-word
// occurrence, found by termOccurrences of src/question.ts, the function the validation uses. The marking is applied to
// the sanitized DOM (web/src/markdown.ts), after DOMPurify: it adds only its own elements and inserts a term's text as
// text, so no markup of an agent passes into the page unsanitized. An edge of the page: it parses HTML in the browser.

import { BLOCK_TAGS, termOccurrences } from "../../src/question.ts";

type Term = Readonly<{ term: string; explanation: string }>;
/** One occurrence in a text node: where it starts, its length and the index of its term. */
type Hit = Readonly<{ at: number; length: number; index: number }>;

/** The occurrences in one text, the longer term first where two overlap, in order. */
const hitsIn = (text: string, terms: readonly Term[]): readonly Hit[] => {
  const all = terms
    .flatMap((t, index) => (t.term.trim() === "" ? [] : termOccurrences(text, t.term).map((at) => ({ at, length: t.term.length, index }))))
    .sort((a, b) => a.at - b.at || b.length - a.length);
  return all.reduce<Hit[]>((kept, hit) => (kept.length > 0 && hit.at < kept[kept.length - 1].at + kept[kept.length - 1].length ? kept : [...kept, hit]), []);
};

/**
 * The inline runs of a DOM tree (S59): its text nodes in document order, a run ended at every start and end of a block
 * element (BLOCK_TAGS of src/question.ts, the ones markdownRuns breaks at), and at a mark already made.
 */
const textRuns = (root: Node): Text[][] => {
  const runs: Text[][] = [[]];
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) runs[runs.length - 1].push(child as Text);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const breaks = BLOCK_TAGS.has(el.tagName.toLowerCase()) || el.classList.contains("term");
        if (breaks) runs.push([]);
        if (!el.classList.contains("term")) walk(el);
        if (breaks) runs.push([]);
      }
    }
  };
  walk(root);
  return runs.filter((r) => r.length > 0);
};

/** The inline runs of rendered HTML, as markdownRuns gives them for its Markdown (S59); blank runs are left out. */
export const domRuns = (root: Node): readonly string[] => textRuns(root).map((r) => r.map((t) => t.data).join("")).filter((r) => r.trim() !== "");

/**
 * The HTML with every occurrence of a term marked (S28, S59). An occurrence is found in the text of one inline run, so a
 * term split by inline markup ('cache **key**') is found as the reader reads it; each text node it spans gets a `.term`
 * fragment naming the term's index (`data-term`) and the occurrence (`data-occurrence`). The first fragment is the
 * occurrence's one focus stop, except inside a link (S40): the link is already a focus stop, and focusing it explains
 * every term it contains (TermText), so that no interactive element is nested in another.
 */
export const markTerms = (html: string, terms: readonly Term[]): string => {
  if (terms.length === 0) return html;
  const root = document.createElement("template");
  root.innerHTML = html;
  let occurrence = 0;
  for (const run of textRuns(root.content)) {
    const hits = hitsIn(run.map((t) => t.data).join(""), terms).map((h) => ({ ...h, key: String(occurrence++) }));
    if (hits.length === 0) continue;
    let offset = 0;
    for (const node of run) {
      const text = node.data;
      const from = offset;
      offset += text.length;
      const pieces = hits.filter((h) => h.at < offset && h.at + h.length > from);
      if (pieces.length === 0) continue;
      const inLink = (node.parentElement?.closest("a") ?? null) !== null;
      const parts = document.createDocumentFragment();
      let at = 0;
      for (const hit of pieces) {
        const start = Math.max(hit.at - from, 0);
        const end = Math.min(hit.at + hit.length - from, text.length);
        if (start > at) parts.append(text.slice(at, start));
        const mark = document.createElement("span");
        mark.className = "term";
        if (!inLink && hit.at >= from) mark.tabIndex = 0;
        mark.dataset.term = String(hit.index);
        mark.dataset.occurrence = hit.key;
        mark.textContent = text.slice(start, end);
        parts.append(mark);
        at = end;
      }
      if (at < text.length) parts.append(text.slice(at));
      node.replaceWith(parts);
    }
  }
  return root.innerHTML;
};

/** A plain text as HTML, for marking terms in text that is not Markdown (the question, an option). */
export const textHtml = (text: string): string => {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
};
