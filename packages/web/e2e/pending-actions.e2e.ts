import { expect, test, waitForServerEvents } from "./fixtures";
import { region } from "./helpers";
import { ISSUE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

for (const scenario of [
  { name: "説明", issue: ISSUE.description, panel: "説明", open: "編集", input: "説明", submit: "保存", operation: "update" },
  { name: "コメント", issue: ISSUE.comment, panel: "Activity", open: null, input: "コメント", submit: "コメントする", operation: "comment" },
  { name: "ラベル", issue: ISSUE.properties, panel: "プロパティ", open: null, input: "ラベルを追加", submit: "追加", operation: "update" },
  { name: "未決事項", issue: ISSUE.addQuestion, panel: "未決事項", open: "未決事項を追加", input: "未決事項", submit: "追加する", operation: "ask" },
  { name: "回答", issue: ISSUE.clarify, panel: "未決事項", open: "回答を記録", input: "回答", submit: "記録する", operation: "answer" },
]) {
  test(`${scenario.name} の送信中は追加入力とフォーム切替を止め、入力を失わない`, async ({ page }) => {
    await page.goto(`/issues/${scenario.issue}`);
    await waitForServerEvents(page);
    const panel = region(page, scenario.panel);
    if (scenario.open) await panel.getByRole("button", { name: scenario.open, exact: true }).first().click();
    const input = panel.getByRole("textbox", { name: scenario.input, exact: true });
    await input.fill("確認済み");

    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    // 実 API へ送る直前で待ち、送信中の入力を確実に検証する。
    await page.route(`**/api/issues/${scenario.issue}/${scenario.operation}`, async (route) => {
      started();
      await gate;
      await route.continue();
    });
    try {
      await panel.getByRole("button", { name: scenario.submit, exact: true }).click();
      await entered;
      await expect(input).toBeDisabled();
      if (scenario.name === "回答") {
        await expect(panel.getByRole("button", { name: "回答を記録", exact: true })).toBeDisabled();
        await expect(panel.getByRole("button", { name: "未決事項を追加", exact: true })).toBeDisabled();
      }
    } finally {
      release();
    }
    if (scenario.name === "説明" || scenario.name === "未決事項" || scenario.name === "回答") {
      await expect(input).toHaveCount(0);
      await expect(panel).toContainText("確認済み");
    } else {
      await expect(input).toHaveValue("");
      await expect(input).toBeEnabled();
      await expect(panel).toContainText("確認済み");
    }
  });
}
