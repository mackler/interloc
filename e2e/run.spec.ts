import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Plan step 5.2: the page against the server over scripted agents (e2e/server.ts), one server per scenario. Every test
// fails on an uncaught error or a console error in any of its pages (e2e/fixtures.ts, finding 10 of docs/gui-review.md).
const PORTS = { converge: 8101, decision: 8102, stop: 8103, interview: 8104, workCorrection: 8105, tabs: 8106, drop: 8107, long: 8108, questionReview: 8109, longChoices: 8110 } as const;
type Scenario = keyof typeof PORTS;
const url = (scenario: Scenario) => `http://127.0.0.1:${PORTS[scenario]}/`;
const left = (page: Page) => page.getByRole("region", { name: "You and Interloq" });
const right = (page: Page) => page.getByRole("region", { name: "Claude and Codex" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Progress of the run" });

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
  await expect(rail(page).getByText("Planning 1", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Execution 1", { exact: true })).toBeVisible();
  await expect(rail(page).getByText("Work review 1", { exact: true })).toBeVisible();
  await expect(right(page).getByText("The step names no file.")).toBeVisible();
  await expect(right(page).getByText(/accepted: rationale P1-R1-1/)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
  await expect(page.locator("button[name=new]")).toBeVisible();
});

test("(2) a decision prompt with its buttons: No decision continues, and the answer is the user's message", async ({ page }) => {
  await startTask(page, "decision", "Add a database");
  await expect(left(page).getByText("Decision on: question from Claude Code: Which database should the service use?")).toBeVisible();
  await page.getByRole("button", { name: "No decision" }).click();
  await expect(left(page).locator("[data-author=user]").getByText("No decision")).toBeVisible();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
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
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
});

test("(4) one click on Stop interrupts the task, and the page offers a new one", async ({ page }) => {
  await startTask(page, "stop", "A task to stop");
  await expect(left(page).getByText(/round 1: Claude Code response/)).toBeVisible();
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
  await expect(left(page).getByText("Interview. /done ends the interview, /quit ends the run; Shift+Enter starts a new line.")).toBeVisible();
  await expect(left(page).getByText('"""')).toHaveCount(0);
  await page.getByRole("button", { name: "1. PostgreSQL" }).click();
  await expect(left(page).getByText("Anything else?")).toBeVisible();
  await page.getByRole("button", { name: "End interview" }).click();
  await expect(left(page).getByText("The service uses PostgreSQL.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  // Four review loops and an execution follow; the run takes about 5 s alone and longer under the whole suite's load.
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
  await expect(rail(page).getByText("Question phase", { exact: true })).toBeVisible();
});

test("(6) a work correction runs planning, execution and the work review a second time", async ({ page }) => {
  await startTask(page, "workCorrection", "Write the tool");
  await expect(left(page).getByText(/finished after 2 execution phase/)).toBeVisible();
  for (const phase of ["Planning 1", "Execution 1", "Work review 1", "Planning 2", "Execution 2", "Work review 2"]) await expect(rail(page).getByText(phase, { exact: true })).toBeVisible();
  await expect(right(page).getByText("The step misses its test.")).toBeVisible();
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
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
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
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
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
  await expect(rail(page).getByText("Planning 1", { exact: true })).toBeVisible();
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
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
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
  await expect(right(page).getByText(/Requirements review, round 1/)).toBeVisible();
  await expect(left(page).getByText(/finished after 1 execution phase/)).toBeVisible();
});
