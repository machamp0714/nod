import { expect, test } from "./fixtures";
import { region } from "./helpers";

// ステータスの遷移ルール（#73）
const section = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "ステータス遷移" });

test.describe("設定画面", () => {
  test.use({ dataset: "issue-list" });

  test("プリセットと許可しない遷移を保存し、禁止できない遷移は理由を示して保存させない", async ({ page, nod }) => {
    await page.goto("/workspaces/API/settings");
    const rules = section(page);
    await expect(rules.getByText("許可しない遷移を設定します。LLM・自動化も従います。LLM は編集できません。")).toBeVisible();
    await expect(rules.getByText("制限はありません。すべての遷移を許可しています。")).toBeVisible();
    await expect(rules.getByRole("button", { name: "遷移ルールを保存" })).toBeDisabled();
    await expect(rules.getByRole("button", { name: "すべて解除" })).toBeDisabled();

    await rules.getByRole("checkbox", { name: "Done の前に In Review を必須にする" }).check();
    await rules.getByRole("button", { name: "+ 遷移を追加" }).click();
    const from = rules.getByRole("combobox", { name: "1 行目の遷移元" });
    const to = rules.getByRole("combobox", { name: "1 行目の遷移先" });
    await expect(from.getByRole("option", { name: "Needs Clarification" })).toHaveCount(0);

    // レビュー承認の経路は塞げない
    await from.selectOption("in_review");
    await to.selectOption("done");
    await expect(rules.getByRole("alert")).toHaveText("In Review → Done は禁止できません（レビューの承認に必要）");
    await expect(from).toHaveAttribute("aria-invalid", "true");
    await expect(rules.getByRole("button", { name: "遷移ルールを保存" })).toBeDisabled();

    await from.selectOption("backlog");
    await to.selectOption("in_progress");
    await expect(rules.getByRole("alert")).toHaveCount(0);
    await rules.getByRole("button", { name: "遷移ルールを保存" }).click();
    await expect(page.getByRole("status")).toHaveText("保存しました");
    expect(await nod.me.getTransitionRules("API")).toEqual({
      workspaceKey: "API",
      forbidden: [{ from: "backlog", to: "in_progress" }],
      presets: ["review_before_done"],
    });
    expect(await nod.me.getTransitionRules("NOD")).toMatchObject({ forbidden: [], presets: [] });

    await page.reload();
    const after = section(page);
    await expect(after.getByRole("checkbox", { name: "Done の前に In Review を必須にする" })).toBeChecked();
    await expect(after.getByRole("combobox", { name: "1 行目の遷移元" })).toHaveValue("backlog");
    await after.getByRole("button", { name: "Backlog → In Progress を削除" }).click();
    await after.getByRole("button", { name: "すべて解除" }).click();
    await expect(after.getByText("制限はありません。すべての遷移を許可しています。")).toBeVisible();
    await after.getByRole("button", { name: "遷移ルールを保存" }).click();
    await expect(page.getByRole("status")).toHaveText("保存しました");
    expect(await nod.me.getTransitionRules("API")).toMatchObject({ forbidden: [], presets: [] });
  });
});

test.describe("Issue 詳細", () => {
  test.use({ dataset: "issue-detail", allowedConsoleErrors: [/status of 409/] });

  test("ルールに反する状態変更はどのルールかを示して拒否し、状態を変えない", async ({ page, nod }) => {
    await nod.me.setTransitionRules("API", { forbidden: [{ from: "backlog", to: "todo" }] });
    await page.goto("/issues/API-4");
    const props = region(page, "プロパティ");
    const status = props.getByRole("combobox", { name: "Status" });
    await expect(status).toHaveValue("backlog");
    await status.selectOption("todo");
    await expect(props.getByRole("alert")).toHaveText("変更できませんでした：Backlog → Todo は許可されていません（ルール: 許可しない遷移）");
    await expect(status).toHaveValue("backlog");
    expect((await nod.me.getIssue("API-4")).status).toBe("backlog");
  });
});

test.describe("自動化", () => {
  test.use({ dataset: "automation" });

  test("遷移ルールで止まる候補は確認結果に理由を示し、実行ではスキップとして数える", async ({ page, nod }) => {
    await nod.me.setAutomationSettings("API", { closeAfterDays: 30, archiveAfterDays: null });
    await nod.me.setTransitionRules("API", { forbidden: [{ from: "backlog", to: "canceled" }] });
    await page.goto("/workspaces/API/settings");
    const auto = page.getByRole("region", { name: "自動化" });
    await auto.getByRole("button", { name: "対象を確認" }).click();
    const table = page.getByRole("region", { name: "対象の確認結果" }).getByRole("table", { name: "canceled にする · 2 件" });
    await expect(table.getByRole("row").filter({ hasText: "API-2" })).toContainText(
      "遷移ルールでスキップ: Backlog → Canceled は許可されていません（ルール: 許可しない遷移）",
    );
    await expect(table.getByRole("row").filter({ hasText: "API-1" })).not.toContainText("遷移ルール");

    await auto.getByRole("button", { name: "今すぐ実行" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "実行する" }).click();
    await expect(page.getByRole("status")).toHaveText("クローズ 1件・アーカイブ 0件・スキップ 1件（遷移ルール 1件）・失敗 0件");
    expect((await nod.me.getIssue("API-1")).status).toBe("canceled");
    expect((await nod.me.getIssue("API-2")).status).toBe("backlog");
  });
});
