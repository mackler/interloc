import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { HELP_ME_DECIDE, loopSummary, transportRetryLine, UNCHANGED_PROCEED, PLAN_STEP_STATE_LABEL, planStepLabel, stageHeading, stepLabel } from "../src/prompts.ts";

// Plan step 5.2: the page against the server over scripted agents (e2e/server.ts), one server per scenario. Every test
// fails on an uncaught error or a console error in any of its pages (e2e/fixtures.ts, finding 10 of docs/gui-review.md).
const PORTS = { converge: 8101, decision: 8102, stop: 8103, interview: 8104, workCorrection: 8105, tabs: 8106, drop: 8107, long: 8108, questionReview: 8109, longChoices: 8110, decide: 8111, decideLong: 8112, decideRevise: 8113, decideBlank: 8114, planSteps: 8115, transportRetry: 8116, unchangedPause: 8117 } as const;
type Scenario = keyof typeof PORTS;
const url = (scenario: Scenario) => `http://127.0.0.1:${PORTS[scenario]}/`;
const left = (page: Page) => page.getByRole("region", { name: "You and Interloq" });
const right = (page: Page) => page.getByRole("region", { name: "Claude and Codex" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Progress of the run" });

type Edges = { left: number; right: number };
/** The horizontal edges of an element's content box: less its padding and, on the right, any scrollbar (P1-R2-2). */
const contentEdges = (el: Locator): Promise<Edges> =>
  el.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const left = r.left + e.clientLeft;
    return { left: left + parseFloat(cs.paddingLeft), right: left + e.clientWidth - parseFloat(cs.paddingRight) };
  });
const edges = (el: Locator): Promise<Edges> => el.evaluate((e) => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right }));
/**
 * Issue #2: a message lies on the named side of the content box of the element it is laid out in (its phase's band, or
 * the panel's list before any phase, issue #15), within 2 px; `container` is the region it is looked up in.
 */
const onSide = async (message: Locator, container: Locator, side: "left" | "right") => {
  await expect(container.locator("xpath=.").first()).toBeVisible();
  const [m, c] = [await edges(message), await contentEdges(message.locator("xpath=.."))];
  expect(Math.abs(m[side] - c[side]), `${side} edge ${m[side]} against ${c[side]}`).toBeLessThanOrEqual(2);
};

/** Opens the page, returns to the form if a run has ended, and starts a task. */
const startTask = async (page: Page, scenario: Scenario, task: string) => {
  await page.goto(url(scenario));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  // The form, an ended run, or a run left by an earlier test on the shared server, which is stopped first.
  await expect(page.locator("textarea[name=task], button[name=new], button[name=stop]:not([disabled])").first()).toBeVisible();
  const stop = page.locator("button[name=stop]");
  const again = page.locator("button[name=new]");
  const form = page.locator("textarea[name=task]");
  // Retried as a whole: the left run can end between the check and the click (it did on a loaded machine), after
  // which Stop stays disabled and a plain click would wait for the test's whole timeout.
  await expect(async () => {
    if (await form.isVisible()) return;
    if (await stop.isEnabled({ timeout: 1_000 }).catch(() => false)) await stop.click({ timeout: 2_000 });
    await again.click({ timeout: 5_000 });
    await expect(form).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await form.fill(task);
  await page.locator("button[name=start]").click();
};

test("(1) a run from the form: the timeline shows its phases and the right panel the agents' exchange", async ({ page }) => {
  await startTask(page, "converge", "Document the service");
  // Issue #6: one iteration, so the phases carry no number.
  await expect(rail(page).getByText("Planning", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Implementation", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Work review", { exact: true })).toBeVisible();
  await expect(right(page).getByText("The step names no file.")).toBeVisible();
  await expect(right(page).getByText(/accepted: rationale P1-R1-1/)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  // Issues #14 and #28: a finished loop is one line with what its cycles resolved, and no limit is shown.
  await expect(rail(page).getByText(loopSummary(2, 1, "converged"), { exact: true })).toBeVisible();
  await expect(rail(page).getByText(loopSummary(1, 0, "converged"), { exact: true })).toBeVisible();
  await expect(rail(page).getByText(/ of \d/)).toHaveCount(0);
  await expect(page.locator("button[name=new]")).toBeVisible();
  // Issue #2: in the right panel Claude speaks from the left and Codex from the right.
  const list = right(page).locator(".list");
  await onSide(list.locator("article[data-author=claude]").first(), list, "left");
  await onSide(list.locator("article[data-author=codex]").first(), list, "right");
  // Issue #15: each phase is a band opened by its label with the time it began; each kind of phase has its own tone.
  await expect(left(page).locator(".phase-label", { hasText: /^Planning · \S/ })).toBeVisible();
  await expect(left(page).locator(".phase-label", { hasText: /^Implementation · \S/ })).toBeVisible();
  const tone = (band: Locator) => band.evaluate((e) => getComputedStyle(e).backgroundColor);
  const [planningTone, executionTone] = [await tone(left(page).locator(".band-planning").first()), await tone(left(page).locator(".band-execution").first())];
  expect(planningTone).not.toBe(executionTone);
  expect(planningTone).not.toBe(await left(page).locator(".list").evaluate((e) => getComputedStyle(e).backgroundColor));
});

test("(2) a decision prompt with its buttons: No decision continues, and the answer is the user's message", async ({ page }) => {
  await startTask(page, "decision", "Add a database");
  await expect(left(page).getByText("Decision on: question from Claude Code: Which database should the service use?")).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).locator("[data-author=user]").getByText("No decision")).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

test("(3) a reload during a run shows the same messages and the pending prompt", async ({ page }) => {
  await startTask(page, "decision", "Add a database again");
  const prompt = left(page).getByText("Decision on: question from Claude Code: Which database should the service use?");
  await expect(prompt).toBeVisible();
  const before = await left(page).locator("article").allTextContents();
  await page.reload();
  await expect(prompt).toBeVisible();
  expect(await left(page).locator("article").allTextContents()).toEqual(before);
  await expect(page.getByRole("button", { name: "No decision" })).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

test("(4) one click on Stop interrupts the task, and the page offers a new one", async ({ page }) => {
  await startTask(page, "stop", "A task to stop");
  await expect(left(page).getByText(/cycle 1: Claude Code response/)).toBeVisible();
  // Issue #14: while the loop runs, each cycle says what its review found.
  await expect(rail(page).getByText("cycle 1: 1 issue", { exact: true })).toBeVisible();
  await page.locator("button[name=stop]").click();
  await expect(left(page).getByText(/INTERRUPTED by the user\. State is preserved in/)).toBeVisible();
  await expect(page.locator("button[name=stop]")).toBeDisabled();
  await page.locator("button[name=new]").click();
  await expect(page.locator("textarea[name=task]")).toBeVisible();
});

// ---- Finding 10 of docs/gui-review.md ------------------------------------------------------------------------

test("the fixture records an uncaught error in a second page of the context", async ({ context, pageErrors }) => {
  const second = await context.newPage();
  await second.goto(url("converge"));
  await second.evaluate(() => void setTimeout(() => { throw new Error("an uncaught error in the second tab"); }));
  await expect.poll(() => pageErrors.length).toBe(1);
  expect(pageErrors[0]).toMatch(/an uncaught error in the second tab/);
  pageErrors.length = 0;
});

test("(5) an interview through confirmation: the page's help, a numbered answer, /done, the confirmed summary", async ({ page }) => {
  await startTask(page, "interview", "Add a service");
  await expect(left(page).getByText("Clarification. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.")).toBeVisible();
  await expect(left(page).getByText('"""')).toHaveCount(0);
  // Issue #21: Gather Requirements shows its steps; the clarification counts the agreed question, answered or not.
  const step = (label: string) => rail(page).locator("[data-step]", { has: page.locator("[data-step-label]", { hasText: label }) });
  await expect(step(stepLabel("formulate"))).toHaveAttribute("data-step", "done");
  await expect(step("Clarification")).toHaveAttribute("data-step", "active");
  await expect(step("Clarification").locator("[data-count]")).toHaveText("0 of 1 answered");
  await page.getByRole("button", { name: "1. PostgreSQL" }).click();
  await expect(left(page).getByText("Anything else?")).toBeVisible();
  await expect(step("Clarification").locator("[data-count]")).toHaveText("1 of 1 answered");
  // Issue #2 (Q5): in the left panel Claude and Interloq speak from the left, the user from the right.
  const list = left(page).locator(".list");
  await onSide(list.locator("article[data-author=claude]").first(), list, "left");
  await onSide(list.locator("article[data-author=program]").first(), list, "left");
  await onSide(list.locator("article[data-author=user]").first(), list, "right");
  // Issue #15 (P1-R1-1, P1-R2-1): inside a band the sides hold, and the band spans the list's content.
  const band = list.locator(".band-questions").first();
  await expect(band.locator("article[data-author=user]").first()).toBeVisible();
  await onSide(band.locator("article[data-author=claude]").first(), band, "left");
  await onSide(band.locator("article[data-author=user]").first(), band, "right");
  const [b, c] = [await edges(band), await contentEdges(list)];
  expect(Math.abs(b.right - b.left - (c.right - c.left)), "the band is as wide as the list's content").toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "End clarification" }).click();
  await expect(left(page).getByText("The service uses PostgreSQL.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  // Four review loops and an execution follow; the run takes about 5 s alone and longer under the whole suite's load.
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  await expect(rail(page).getByText("Gather Requirements", { exact: true })).toBeVisible();
  await expect(step("Clarification")).toHaveAttribute("data-step", "done");
  await expect(step("Clarification").getByText(loopSummary(1, 0, "converged"), { exact: true })).toBeVisible();
});

test("(6) a work correction runs planning, execution and the work review a second time", async ({ page }) => {
  await startTask(page, "workCorrection", "Write the tool");
  await expect(left(page).getByText(/finished after 2 implementation phase/)).toBeVisible();
  for (const phase of ["Planning 1", "Implementation 1", "Work review 1", "Planning 2", "Implementation 2", "Work review 2"]) await expect(rail(page).getByText(phase, { exact: true })).toBeVisible();
  // Issue #14 (G-R1-1): the work review that led to the second planning phase names its corrections due.
  await expect(rail(page).getByText(loopSummary(1, 1, "revise"), { exact: true })).toBeVisible();
  await expect(right(page).getByText("The step misses its test.")).toBeVisible();
  // Issue #15: every planning phase has the same tone, and so has every execution phase, apart from the other's.
  const tones = (kind: string) => left(page).locator(`.band-${kind}`).evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  const [planning, execution] = [await tones("planning"), await tones("execution")];
  expect(planning.length).toBe(2);
  expect(execution.length).toBe(2);
  expect(new Set(planning).size).toBe(1);
  expect(new Set(execution).size).toBe(1);
  expect(planning[0]).not.toBe(execution[0]);
});

test("(7) two tabs: another tab's answer withdraws the unsent draft with a notice, and the run continues", async ({ context, page }) => {
  await startTask(page, "tabs", "Add a database");
  const other = await context.newPage();
  await other.goto(url("tabs"));
  const first = "Decision on: question from Claude Code: Which database should the service use?";
  await expect(left(other).getByText(first)).toBeVisible();
  await other.locator("[name=answer]").fill("an unsent answer");
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(other).getByText("Decision on: question from Claude Code: Which cache should the service use?")).toBeVisible();
  await expect(other.locator("[name=answer]")).toHaveValue("");
  await expect(other.getByText(/answered in another tab; your unsent text was discarded: «an unsent answer»/)).toBeVisible();
  await other.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

test("(8) a dropped connection: an answer made meanwhile is sent once after the hello, and the replay duplicates nothing", async ({ page }) => {
  let hold = false;
  let current: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (hold) {
      ws.close();
      return;
    }
    current = ws;
    ws.connectToServer();
  });
  await startTask(page, "drop", "Add a database");
  const prompt = "Decision on: question from Claude Code: Which database should the service use?";
  await expect(left(page).getByText(prompt)).toBeVisible();
  hold = true;
  await current!.close();
  await expect(page.getByText("reconnecting…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  hold = false;
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  await expect(left(page).getByText(prompt)).toHaveCount(1);
  await expect(left(page).locator("[data-author=user]").getByText("No decision")).toHaveCount(1);
});

test("(9) a long transcript: scrolled up, the position stays while messages arrive, and the chip leads to the end", async ({ page }) => {
  await startTask(page, "long", "Plan in detail");
  await expect(page.getByRole("button", { name: "No decision" })).toBeVisible({ timeout: 60_000 });
  const list = left(page).locator(".list");
  expect(await left(page).locator("article").count()).toBeGreaterThan(150);
  await list.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).getByRole("button", { name: /new message/ })).toBeVisible();
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  await left(page).getByRole("button", { name: /new message/ }).click();
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(32);
});

test("(10) Start still starts when the browser refuses to store the directory", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("access denied", "SecurityError");
    };
  });
  await startTask(page, "converge", "Document the service once more");
  await expect(rail(page).getByText("Planning", { exact: true })).toBeVisible();
});

test("(11) Enter while an input method is composing does not answer", async ({ page }) => {
  await startTask(page, "decision", "Add a database with composition");
  const prompt = left(page).getByText("Decision on: question from Claude Code: Which database should the service use?");
  await expect(prompt).toBeVisible();
  const field = page.locator("[name=answer]");
  await field.fill("unfinished composition");
  await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(300);
  await expect(left(page).locator("[data-author=user]")).toHaveCount(0);
  await expect(field).toHaveValue("unfinished composition");
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

// Defect A of docs/page-question-phase-defects.md: the page had never carried a question phase whose review raised an
// issue; the response with the amended list stopped the page, live and in every replay.
test("(12) a question phase through the page: the list's review and response, one interview turn, an answer, the requirements review", async ({ context, page }) => {
  await startTask(page, "questionReview", "Add a service");
  await expect(right(page).getByText("The list does not ask for the port.")).toBeVisible();
  await expect(right(page).getByText(/accepted: rationale Q-R1-1/)).toBeVisible();
  await expect(left(page).getByText(/Which database should the service use\?/).first()).toBeVisible();
  // A second tab receives the same run by replay, and the pending interview prompt with it.
  const other = await context.newPage();
  await other.goto(url("questionReview"));
  await expect(right(other).getByText(/accepted: rationale Q-R1-1/)).toBeVisible();
  await expect(other.getByRole("button", { name: "1. PostgreSQL" })).toBeVisible();
  await other.close();
  await page.getByRole("button", { name: "1. PostgreSQL" }).click();
  await expect(left(page).getByText("The service uses PostgreSQL on port 8080.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(right(page).getByText(/Requirements review, cycle 1/)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

// Decision support: "Help me decide" on a question with options, the analysis over both chat columns, then the answer.
test("(13) Help me decide: the analysis covers the chat columns until the question is answered", async ({ page }) => {
  await startTask(page, "decide", "Add a database");
  await expect(left(page).getByText("Decision on: question from Claude Code: Which database should the service use?")).toBeVisible();
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  await expect(analysis.locator(".column h3")).toHaveText(["SQLite", "PostgreSQL"]);
  await expect(analysis.getByText("Disadvantages:").first()).toBeVisible();
  await expect(analysis.getByText("On the other hand, the server needs its own configuration. *")).toBeVisible();
  await expect(left(page)).toBeHidden();
  // The conversation is one click away, and the analysis one click back.
  await page.getByRole("button", { name: "Show the conversation" }).click();
  await expect(left(page)).toBeVisible();
  await page.getByRole("button", { name: "Show the analysis" }).click();
  await expect(analysis).toBeVisible();
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /PostgreSQL/ }).click();
  await expect(analysis).toBeHidden();
  await expect(left(page).locator("[data-author=user]").getByText("PostgreSQL — a database server")).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

// W2-R1-1: a decision whose analysis is revised in its review: the response reaches the page, which stays connected.
test("(14) a revised analysis: the decision's response reaches the page, which stays connected and shows the amended analysis", async ({ page }) => {
  await startTask(page, "decideRevise", "Add a database");
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  await expect(analysis.getByText("The amended advantage: developers set up the service sooner.")).toBeVisible();
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByText(/could not read a message|stopped reconnecting/)).toHaveCount(0);
  await page.getByRole("button", { name: "Show the conversation" }).click();
  await expect(right(page).getByText(/D1-R1-1/).first()).toBeVisible();
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

// W3-R1-1: an empty message after the analysis is rejected and asked again; the analysis stays until the answer.
test("(15) a rejected empty reply keeps the analysis shown; the answer that follows dismisses it", async ({ page }) => {
  await startTask(page, "decideBlank", "Add a service");
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  await page.locator("textarea[name=answer]").press("Enter");
  // The Help me decide answer and the empty one.
  await expect(page.locator("[data-author=user]")).toHaveCount(2);
  await expect(analysis).toBeVisible();
  await expect(analysis.locator(".column h3")).toHaveText(["PostgreSQL", "SQLite"]);
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: "1. PostgreSQL" }).click();
  await expect(analysis).toBeHidden();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

test("(16) the plan in the rail: its stages and steps under the Implementation that carries it out, the current step, the revision", async ({ page }) => {
  await startTask(page, "planSteps", "Build the rail");
  const step = (label: string) => rail(page).locator("[data-plan-step]", { has: page.locator("[data-plan-step-label]", { hasText: label }) });
  // The run waits in its second execution: the stop of the first foresaw the second iteration, so every phase is numbered.
  await expect(step(planStepLabel(2, "The store"))).toHaveAttribute("data-plan-step", "current");
  for (const phase of ["Planning 1", "Implementation 1", "Work review 1", "Planning 2", "Implementation 2", "Work review 2"]) await expect(rail(page).getByText(phase, { exact: true })).toBeVisible();
  // The revised plan hangs under Implementation 2 alone (Q5, Q9), with its new stage and step.
  const implementation2 = rail(page).locator("[data-state]", { has: page.locator("[data-label]", { hasText: /^Implementation 2$/ }) });
  await expect(implementation2.getByText(stageHeading(2, "the page"), { exact: true })).toBeVisible();
  await expect(rail(page).locator("[data-plan-step]")).toHaveCount(3);
  await expect(step(planStepLabel(1, "Structured user questions (Q1)")).locator(".mark")).toHaveAttribute("aria-label", PLAN_STEP_STATE_LABEL.done);
  await expect(step(planStepLabel(1, "The long step"))).toHaveAttribute("data-plan-step", "pending");
  // The step's full text by keyboard.
  await step(planStepLabel(1, "Structured user questions (Q1)")).locator("button").focus();
  await expect(rail(page).getByRole("tooltip")).toContainText("Add the schema of a question.");
  await page.keyboard.press("Escape");
  await expect(rail(page).getByRole("tooltip")).toHaveCount(0);
  await page.locator("button[name=stop]").click();
  await expect(page.locator("button[name=new]")).toBeVisible();
  // After the stop no execution runs: the started step is unfinished.
  await expect(step(planStepLabel(2, "The store"))).toHaveAttribute("data-plan-step", "unfinished");
});

test("(17) a Codex turn that loses its connection: the page shows the retry, and the run converges (issue #26)", async ({ page }) => {
  await startTask(page, "transportRetry", "Document the service");
  await expect(page.locator("[data-activity]")).toContainText("retry 1 of 3");
  await expect(left(page).getByText(transportRetryLine("codex", 1, 3, 2, "stream disconnected before completion"))).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});

test("(18) the pause of an accepted issue with the file unchanged: Proceed continues the review (issue #30)", async ({ page }) => {
  await startTask(page, "unchangedPause", "Document the service");
  await page.getByRole("button", { name: UNCHANGED_PROCEED, exact: true }).click();
  await expect(left(page).locator("[data-author=user]").getByText(UNCHANGED_PROCEED)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
});
