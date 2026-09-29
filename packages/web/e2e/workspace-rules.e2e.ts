import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const editor = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "LLM に守らせる作業規約" });

test("Sidebar の歯車から設定を開き、作業規約を登録・更新・削除できる", async ({ page, nod }) => {
  await page.goto("/issues?q=API");
  await page.getByRole("link", { name: "api-server の設定" }).click();
  await expect(page).toHaveURL(/\/workspaces\/API\/settings$/);
  await expect(page.getByRole("link", { name: "api-server の設定" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "api-server の設定" })).toBeVisible();
  await expect(page.getByText("未登録")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "規約を削除" })).toHaveCount(0);
  await expect(editor(page)).toHaveAttribute("placeholder", "例: コミットメッセージは日本語で書く");

  await editor(page).fill("## 作業規約\n- コミットメッセージは日本語で書く\n");
  await expect(page.getByTestId("rules-count")).toHaveText("26 / 10,000 文字");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(page.getByText(/^最終更新 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · me$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(await nod.me.getWorkspaceRules("API")).toMatchObject({ body: "## 作業規約\n- コミットメッセージは日本語で書く", updatedBy: "me" });

  await page.reload();
  await expect(editor(page)).toHaveValue("## 作業規約\n- コミットメッセージは日本語で書く");
  await editor(page).fill("- PR は draft で作る");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect((await nod.me.getWorkspaceRules("API"))?.body).toBe("- PR は draft で作る");

  await page.getByRole("button", { name: "規約を削除" }).click();
  const dialog = page.getByRole("alertdialog", { name: "作業規約を削除しますか？" });
  await expect(dialog).toContainText("LLM の出力から消えます");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nod.me.getWorkspaceRules("API")).not.toBeNull();

  await page.getByRole("button", { name: "規約を削除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText("未登録")).toBeVisible();
  await expect(editor(page)).toHaveValue("");
  expect(await nod.me.getWorkspaceRules("API")).toBeNull();
  // 他の Workspace の規約は変わらない
  expect(await nod.me.getWorkspaceRules("NOD")).toBeNull();
});

test("上限を超えると文字数とエラーを赤で示し、保存できない", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  await editor(page).fill("a".repeat(10012));
  await expect(page.getByTestId("rules-count")).toHaveText("10,012 / 10,000 文字");
  await expect(page.getByRole("alert")).toHaveText("10,000 文字以内で入力してください");
  await expect(editor(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await editor(page).fill("a".repeat(10000));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  expect(await nod.me.getWorkspaceRules("API")).toBeNull();
});

test("CLI など別の場所で登録された規約を表示し、存在しない Workspace は見つからないと示す", async ({ page, nod }) => {
  await nod.me.setWorkspaceRules("NOD", "- 外部で登録");
  await page.goto("/workspaces/nod/settings");
  await expect(page.getByRole("heading", { name: "nod の設定" })).toBeVisible();
  await expect(editor(page)).toHaveValue("- 外部で登録");
  await page.goto("/workspaces/ZZZ/settings");
  await expect(page.getByText("Workspace が見つかりません")).toBeVisible();
});

test.describe("保存の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  test("失敗すると理由を示し、入力を保つ", async ({ page, nod }) => {
    await page.route("**/api/workspaces/API/rules", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED", message: "保存に失敗しました" } }) })
        : route.fallback(),
    );
    await page.goto("/workspaces/API/settings");
    await editor(page).fill("- 失敗させる");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
    await expect(editor(page)).toHaveValue("- 失敗させる");
    expect(await nod.me.getWorkspaceRules("API")).toBeNull();
  });
});
