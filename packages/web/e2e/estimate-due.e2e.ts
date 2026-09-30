import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE } from "./issue-detail-data";

test.describe("Issue 詳細の見積もり・期限", () => {
  test.use({ dataset: "issue-detail" });

  test("見積もりと期限を設定・解除でき、再読み込みしても残る。期限超過を示す", async ({ page }) => {
    await page.goto(`/issues/${ISSUE.properties}`);
    const props = region(page, "プロパティ");
    const estimate = props.getByRole("button", { name: "Estimate を編集" });
    await expect(estimate).toHaveText("なし");

    await estimate.click();
    await props.getByRole("textbox", { name: "Estimate" }).fill("0");
    await props.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(props.getByRole("alert")).toHaveText("1〜100 の整数で入力してください");
    await props.getByRole("textbox", { name: "Estimate" }).fill("3");
    await props.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(estimate).toHaveText("3 pt");

    const due = props.getByRole("button", { name: "Due date を編集" });
    await expect(due).toHaveText("なし");
    await due.click();
    await props.getByLabel("Due date", { exact: true }).fill("2020-01-02");
    await props.getByLabel("Due date", { exact: true }).press("Enter");
    await expect(due).toContainText("2020年1月2日");
    await expect(due).toContainText("期限超過");

    await page.reload();
    const after = region(page, "プロパティ");
    await expect(after.getByRole("button", { name: "Estimate を編集" })).toHaveText("3 pt");
    await expect(after.getByRole("button", { name: "Due date を編集" })).toContainText("期限超過");

    await after.getByRole("button", { name: "Due date を編集" }).click();
    await after.getByRole("button", { name: "解除", exact: true }).click();
    await expect(after.getByRole("button", { name: "Due date を編集" })).toHaveText("なし");
    await after.getByRole("button", { name: "Estimate を編集" }).click();
    await after.getByRole("textbox", { name: "Estimate" }).fill("");
    await after.getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(after.getByRole("button", { name: "Estimate を編集" })).toHaveText("なし");
    await page.reload();
    await expect(region(page, "プロパティ").getByRole("button", { name: "Estimate を編集" })).toHaveText("なし");
  });

  test.describe("期限をキーボードで入力する", () => {
    // 日付欄の区切り（月/日/年）を固定する
    test.use({ locale: "en-US" });

    test("入力途中の日付では保存せず、Enter で確定する", async ({ page }) => {
      await page.goto(`/issues/${ISSUE.properties}`);
      const props = region(page, "プロパティ");
      const due = props.getByRole("button", { name: "Due date を編集" });
      await due.click();
      const input = props.getByLabel("Due date", { exact: true });
      // 年の1桁目を打った時点で値は 0002-10-15 になるが、ここで保存・終了してはいけない
      await input.pressSequentially("10152026", { delay: 30 });
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("2026-10-15");
      await input.press("Enter");
      await expect(due).toContainText("10月15日");
      await page.reload();
      await expect(region(page, "プロパティ").getByRole("button", { name: "Due date を編集" })).toContainText("10月15日");
    });

    test("1900年より前の日付は保存せず、欄を開いたまま知らせる", async ({ page }) => {
      await page.goto(`/issues/${ISSUE.properties}`);
      const props = region(page, "プロパティ");
      await props.getByRole("button", { name: "Due date を編集" }).click();
      const input = props.getByLabel("Due date", { exact: true });
      await input.pressSequentially("10150002", { delay: 30 });
      await input.press("Enter");
      await expect(props.getByRole("alert")).toHaveText("1900-01-01 以降の日付を入力してください");
      await input.press("Escape");
      await page.reload();
      await expect(region(page, "プロパティ").getByRole("button", { name: "Due date を編集" })).toHaveText("なし");
    });

    test("フォーカスを外すと確定する", async ({ page }) => {
      await page.goto(`/issues/${ISSUE.properties}`);
      const props = region(page, "プロパティ");
      const due = props.getByRole("button", { name: "Due date を編集" });
      await due.click();
      await props.getByLabel("Due date", { exact: true }).pressSequentially("01022031", { delay: 30 });
      await page.getByRole("heading", { level: 1 }).click();
      await expect(due).toContainText("2031年1月2日");
    });
  });

  test("Escape は入力を取り消して保存しない", async ({ page }) => {
    await page.goto(`/issues/${ISSUE.properties}`);
    const props = region(page, "プロパティ");
    await props.getByRole("button", { name: "Estimate を編集" }).click();
    await props.getByRole("textbox", { name: "Estimate" }).fill("5");
    await props.getByRole("textbox", { name: "Estimate" }).press("Escape");
    await expect(props.getByRole("button", { name: "Estimate を編集" })).toHaveText("なし");
    await page.reload();
    await expect(region(page, "プロパティ").getByRole("button", { name: "Estimate を編集" })).toHaveText("なし");
  });
});

test.describe("Issue 一覧の見積もり・期限列", () => {
  test.use({ dataset: "issue-list" });

  test("既定では出さず、表示設定で列と並び順を選べる。未設定は末尾、超過を示す", async ({ page, nod }) => {
    await nod.me.updateIssue("API-12", { title: "AAA 期限確認", estimate: 5, dueDate: "2020-01-02" });
    await nod.me.updateIssue("API-8", { title: "BBB 期限確認", estimate: 2, dueDate: "2999-10-01" });
    await nod.me.updateIssue("API-9", { title: "CCC 期限確認" });
    await page.goto("/issues");
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR"]);
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("期限確認");
    await page.getByText("表示設定", { exact: true }).click();
    await page.getByRole("checkbox", { name: "見積もり", exact: true }).check();
    await page.getByRole("checkbox", { name: "期限", exact: true }).check();
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR", "見積もり", "期限"]);
    await page.getByLabel("並び順", { exact: true }).selectOption("dueDate");
    await page.getByLabel("並び順の方向", { exact: true }).selectOption("desc");
    const rows = page.getByRole("table").locator("tbody tr");
    await expect(rows.getByRole("link")).toHaveText(["BBB 期限確認", "AAA 期限確認", "CCC 期限確認"]);
    await expect(rows.nth(0)).toContainText("2 pt");
    await expect(rows.nth(0)).toContainText("2999年10月1日");
    await expect(rows.nth(0)).not.toContainText("期限超過");
    await expect(rows.nth(1)).toContainText("5 pt");
    await expect(rows.nth(1)).toContainText("2020年1月2日");
    await expect(rows.nth(1)).toContainText("期限超過");
    await page.reload();
    await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR", "見積もり", "期限"]);
    await page.getByLabel("並び順", { exact: true }).waitFor({ state: "attached" });
    await expect(page).toHaveURL(/sort=dueDate/);
  });
});
