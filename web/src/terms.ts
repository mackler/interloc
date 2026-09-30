// The terms of a question marked in its rendered HTML (S28, issue #36, decision Q5): every case-sensitive, whole-word
// occurrence, found by termOccurrences of src/question.ts, the function the validation uses. The marking is applied to
// the sanitized DOM (web/src/markdown.ts), after DOMPurify: it adds only its own elements and inserts a term's text as
// text, so no markup of an agent passes into the page unsanitized. An edge of the page: it parses HTML in the browser.

import { termOccurrences } from "../../src/question.ts";

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
 * The HTML with every occurrence of a term wrapped in a `.term` naming the term's index (`data-term`). A mark is
 * focusable, except inside a link (S40, W2-R1-3): the link is already a focus stop, and focusing it explains every term
 * it contains (TermText), so that no interactive element is nested in another.
 */
export const markTerms = (html: string, terms: readonly Term[]): string => {
  if (terms.length === 0) return html;
  const root = document.createElement("template");
  root.innerHTML = html;
  const walker = document.createTreeWalker(root.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) if ((n.parentElement?.closest(".term") ?? null) === null) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.data;
    const inLink = (node.parentElement?.closest("a") ?? null) !== null;
    const hits = hitsIn(text, terms);
    if (hits.length === 0) continue;
    const parts = document.createDocumentFragment();
    let from = 0;
    for (const hit of hits) {
      if (hit.at > from) parts.append(text.slice(from, hit.at));
      const mark = document.createElement("span");
      mark.className = "term";
      if (!inLink) mark.tabIndex = 0;
      mark.dataset.term = String(hit.index);
      mark.textContent = text.slice(hit.at, hit.at + hit.length);
      parts.append(mark);
      from = hit.at + hit.length;
    }
    if (from < text.length) parts.append(text.slice(from));
    node.replaceWith(parts);
  }
  return root.innerHTML;
};

/** A plain text as HTML, for marking terms in text that is not Markdown (the question, an option). */
export const textHtml = (text: string): string => {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
};
