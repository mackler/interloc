// Markdown of the agents, rendered and sanitised in the browser (decision Q1: marked + dompurify).

import DOMPurify from "dompurify";
import { marked } from "marked";

// Every link leaves the page without access to it. Registered once, when the module loads.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** HTML for `{@html}`: marked's output with every script, event handler and unsafe URL removed. */
export const render = (markdown: string): string => DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }), { ADD_ATTR: ["target"] });
