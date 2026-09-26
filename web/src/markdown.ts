// Markdown of the agents, rendered and sanitised in the browser (decision Q1: marked + dompurify).
// An edge of the page (finding 14 of docs/gui-review.md): the sanitizer is a private instance made from the window
// by `makeRenderer`, and its link hook is registered on that instance only; the imported DOMPurify singleton is never
// configured, so no other consumer of the library is affected.

import DOMPurify, { type WindowLike } from "dompurify";
import { marked } from "marked";

/** A renderer over its own sanitizer: marked's output with every script, event handler and unsafe URL removed. */
export const makeRenderer = (root: WindowLike): ((markdown: string) => string) => {
  const purify = DOMPurify(root);
  // Every link leaves the page without access to it.
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (markdown) => purify.sanitize(marked.parse(markdown, { async: false, gfm: true }), { ADD_ATTR: ["target"] });
};

/** HTML for `{@html}`: the page's one renderer, made at the browser boundary when the module loads. */
export const render: (markdown: string) => string = makeRenderer(window);
