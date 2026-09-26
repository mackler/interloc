// The fixture of every end-to-end test (finding 10 of docs/gui-review.md): an uncaught page error or a console error
// in any page of the test's context fails the test, the second tab of a scenario included.

import { test as base, expect, type Page } from "@playwright/test";

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({}, use) => {
    await use([]);
  },
  context: async ({ context, pageErrors }, use) => {
    const watch = (page: Page) => {
      page.on("pageerror", (error) => void pageErrors.push(`uncaught: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
      });
    };
    context.pages().forEach(watch);
    context.on("page", watch);
    await use(context);
    expect(pageErrors, "errors in the pages of this test").toEqual([]);
  },
});
export { expect };
