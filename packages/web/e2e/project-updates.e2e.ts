import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "issue-list" });
const input = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "進捗報告の本文" });
const records = (page: import("@playwright/test").Page) => page.getByRole("article", { name: "進捗報告の記録" });

test("Web で書いた報告を書き手・日時つきで新しい順に表示し、本文はプレーンテキストのまま出す", async ({ page, nod }) => {
  const before = await nod.me.getProject("1");
  await page.goto("/projects/1?q=API");
  const section = page.getByRole("region", { name: "進捗報告" });
  await expect(page.getByText("進捗報告はありません")).toBeVisible();
  await expect(section.getByRole("heading", { name: "進捗報告" })).toBeVisible();
  await expect(section.getByText("0", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "報告する" })).toBeDisabled();
  await input(page).fill("<b>太字にしない</b>\n二行目");
  await page.getByRole("button", { name: "報告する" }).click();
  await expect(input(page)).toHaveValue("");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("me");
  await expect(records(page).first().locator("p")).toHaveText("<b>太字にしない</b>\n二行目");
  await expect(records(page).first().locator("b")).toHaveCount(0);
  await expect(records(page).first().locator("time")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await input(page).fill("次の報告");
  await page.getByRole("button", { name: "報告する" }).click();
  await expect(records(page)).toHaveCount(2);
  await expect(records(page).first()).toContainText("次の報告");
  await expect(section.getByText("2", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/q=API/);

  const after = await nod.me.getProject("1");
  expect(after.updates.map((u) => [u.author, u.body])).toEqual([["me", "次の報告"], ["me", "<b>太字にしない</b>\n二行目"]]);
  expect(after).toMatchObject({ status: before.status, updatedAt: before.updatedAt });
  expect(after.issues).toEqual(before.issues);
  expect((await nod.me.getProject("2")).updates).toEqual([]);
  await page.goto("/projects/2");
  await expect(records(page)).toHaveCount(0);
});

test.describe("保存状態", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });
  test("保存中は二重投稿を防ぎ、失敗時は下書きと理由を残して再試行できる", async ({ page, nod }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/projects/1/reports", async (route) => {
      await waiting;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_ARGS", message: "保存に失敗しました" } }) });
    });
    try {
      await page.goto("/projects/1");
      await input(page).fill("下書き");
      await page.getByRole("button", { name: "報告する" }).click();
      await expect(input(page)).toBeDisabled();
      await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "報告する" })).toHaveCount(0);
      release();
      await expect(page.getByRole("alert")).toHaveText("保存できませんでした：保存に失敗しました");
      await expect(input(page)).toHaveAttribute("aria-invalid", "true");
      await expect(input(page)).toHaveValue("下書き");
      await expect(records(page)).toHaveCount(0);
      await page.unroute("**/api/projects/1/reports");
      await page.getByRole("button", { name: "報告する" }).click();
      await expect(records(page)).toHaveCount(1);
      await expect(input(page)).toHaveValue("");
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect((await nod.me.getProject("1")).updates.map((u) => u.body)).toEqual(["下書き"]);
    } finally { release(); }
  });
});

test("LLM の報告が SSE で開いた詳細に反映し、書きかけの下書きを保つ", async ({ page, nod }) => {
  await page.goto("/projects/1");
  await waitForServerEvents(page);
  await input(page).fill("書きかけ");
  await nod.codex.addProjectUpdate("1", "codex の報告");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("codex");
  await expect(records(page).first()).toContainText("codex の報告");
  await expect(input(page)).toHaveValue("書きかけ");
});
