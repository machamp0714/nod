import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const templatesSection = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "テンプレート", exact: true });

// #160: テンプレートは全 Workspace 共通のまま、Workspace の設定から追加・本文の編集・削除ができる
test("テンプレートを追加・本文の編集・削除でき、どの Workspace の設定にも同じ一覧を出す", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  const section = templatesSection(page);
  await expect(section.getByText("Issue の説明の雛形。すべての Workspace で共通です。LLM は編集できません。")).toBeVisible();
  await expect(section.getByText("テンプレートはありません")).toBeVisible();

  // 追加：名前と本文がそろうまで押せず、名前は前後の空白を除く
  const add = section.getByRole("form", { name: "テンプレートを追加" });
  await expect(add.getByRole("button", { name: "追加" })).toBeDisabled();
  await add.getByRole("textbox", { name: "テンプレート名" }).fill(" 週次レビュー ");
  await expect(add.getByRole("button", { name: "追加" })).toBeDisabled();
  await add.getByRole("textbox", { name: "本文" }).fill("## 今週やったこと\n- \n");
  await add.getByRole("button", { name: "追加" }).click();
  await expect(page.getByRole("status")).toHaveText("追加しました");
  await expect(section.getByText("テンプレートはありません")).toHaveCount(0);
  const row = section.getByRole("listitem").filter({ hasText: "週次レビュー" });
  await expect(row).toContainText(/更新 \d{4}-\d{2}-\d{2}/);
  await expect(add.getByRole("textbox", { name: "テンプレート名" })).toHaveValue("");
  await expect(add.getByRole("textbox", { name: "本文" })).toHaveValue("");
  expect(await nod.me.listTemplates()).toMatchObject([{ name: "週次レビュー", body: "## 今週やったこと\n- \n" }]);

  // 同じ名前は追加できず、本文を上書きしない
  await add.getByRole("textbox", { name: "テンプレート名" }).fill("週次レビュー");
  await add.getByRole("textbox", { name: "本文" }).fill("上書き");
  await add.getByRole("button", { name: "追加" }).click();
  await expect(add.getByRole("alert")).toHaveText("同じ名前のテンプレート「週次レビュー」がすでにあります。本文を変えるには編集してください");
  await expect(add.getByRole("textbox", { name: "テンプレート名" })).toHaveAttribute("aria-invalid", "true");
  expect((await nod.me.listTemplates())[0]!.body).toBe("## 今週やったこと\n- \n");

  // 本文の編集：名前は変えられず、変えるまで保存できない。キャンセルは保存しない
  await row.getByRole("button", { name: "週次レビュー を編集" }).click();
  const edit = section.getByRole("form", { name: "週次レビュー を編集" });
  await expect(edit.getByText("名前は変更できません")).toBeVisible();
  const body = edit.getByRole("textbox", { name: "週次レビュー の本文" });
  await expect(body).toHaveValue("## 今週やったこと\n- \n");
  await expect(edit.getByRole("button", { name: "保存" })).toBeDisabled();
  await body.fill("破棄する下書き");
  await edit.getByRole("button", { name: "キャンセル" }).click();
  await expect(edit).toHaveCount(0);
  await row.getByRole("button", { name: "週次レビュー を編集" }).click();
  await expect(body).toHaveValue("## 今週やったこと\n- \n");
  await body.fill("## 今週やったこと\n- \n\n## 来週やること\n- \n");
  await edit.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(edit).toHaveCount(0);
  expect(await nod.me.listTemplates()).toMatchObject([{ name: "週次レビュー", body: "## 今週やったこと\n- \n\n## 来週やること\n- \n" }]);

  // 全 Workspace 共通：別の Workspace の設定にも同じテンプレートが出て、定期Issue の本文に選べる
  await page.goto("/workspaces/NOD/settings");
  await expect(templatesSection(page).getByRole("listitem").filter({ hasText: "週次レビュー" })).toBeVisible();

  // 削除：確認を経て消す。キャンセルでは消さない
  await templatesSection(page).getByRole("button", { name: "週次レビュー を削除" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("テンプレート『週次レビュー』を削除しますか？");
  await expect(dialog).toContainText("定期Issue で使っている場合、その起票は失敗します");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nod.me.listTemplates()).toHaveLength(1);
  await templatesSection(page).getByRole("button", { name: "週次レビュー を削除" }).click();
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("削除しました");
  await expect(templatesSection(page).getByText("テンプレートはありません")).toBeVisible();
  expect(await nod.me.listTemplates()).toEqual([]);
});

test("CLI など別の場所での登録・置き換え・削除を表示し、編集中の下書きは保つ", async ({ page, nod }) => {
  await nod.me.saveTemplate({ name: "bug", body: "v1" });
  await page.goto("/workspaces/API/settings");
  const section = templatesSection(page);
  await section.getByRole("button", { name: "bug を編集" }).click();
  const body = section.getByRole("textbox", { name: "bug の本文" });
  await body.fill("下書き");
  await nod.me.saveTemplate({ name: "feature/new", body: "## 目的" });
  await expect(section.getByRole("listitem").filter({ hasText: "feature/new" })).toBeVisible();
  await expect(body).toHaveValue("下書き");

  await nod.me.removeTemplate("feature/new");
  await expect(section.getByRole("listitem").filter({ hasText: "feature/new" })).toHaveCount(0);
  expect((await nod.me.listTemplates()).map((t) => t.name)).toEqual(["bug"]);
});

test.describe("保存の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of (404|500)/] });

  test("追加に失敗すると理由を示し、入力を保つ", async ({ page, nod }) => {
    await page.route("**/api/templates", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED", message: "保存に失敗しました" } }) })
        : route.fallback(),
    );
    await page.goto("/workspaces/API/settings");
    const add = templatesSection(page).getByRole("form", { name: "テンプレートを追加" });
    await add.getByRole("textbox", { name: "テンプレート名" }).fill("bug");
    await add.getByRole("textbox", { name: "本文" }).fill("## 再現手順");
    await add.getByRole("button", { name: "追加" }).click();
    await expect(add.getByRole("alert")).toHaveText("保存に失敗しました");
    await expect(add.getByRole("textbox", { name: "テンプレート名" })).toHaveValue("bug");
    await expect(add.getByRole("textbox", { name: "本文" })).toHaveValue("## 再現手順");
    expect(await nod.me.listTemplates()).toEqual([]);
  });

  test("編集中に別の場所で消されたテンプレートは、保存しても復活させない", async ({ page, nod }) => {
    const { template } = await nod.me.saveTemplate({ name: "bug", body: "v1" });
    // 一覧の読み直しで行が消える前に保存した場合を再現するため、一覧は消す前のものを返し続ける
    await page.route("**/api/templates", (route) => (route.request().method() === "GET" ? route.fulfill({ json: [template] }) : route.fallback()));
    await page.goto("/workspaces/API/settings");
    const section = templatesSection(page);
    await section.getByRole("button", { name: "bug を編集" }).click();
    await nod.me.removeTemplate("bug");
    const edit = section.getByRole("form", { name: "bug を編集" });
    await edit.getByRole("textbox", { name: "bug の本文" }).fill("v2");
    await edit.getByRole("button", { name: "保存" }).click();
    await expect(edit.getByRole("alert")).toContainText("テンプレート bug はありません");
    expect(await nod.me.listTemplates()).toEqual([]);
  });
});
