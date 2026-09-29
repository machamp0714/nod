import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { DOC, ISSUE, MAIN_TITLE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

const docsDir = (dir: string) => join(dir, "documents");

test("Documents 一覧は種類・リンク先 Issue・作成日を出し、種類の絞り込みを URL に残す", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("navigation", { name: "メイン" }).getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("heading", { level: 1, name: "Documents" })).toBeVisible();
  const rows = page.getByRole("row");
  await expect(rows).toHaveCount(4); // 見出し + 3件
  const spec = rows.filter({ hasText: "検索 API の高速化 設計" });
  await expect(spec).toContainText("Spec");
  await expect(spec.getByRole("link", { name: ISSUE.main })).toBeVisible();

  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("menuitemradio", { name: "Plan" }).click();
  await expect(page).toHaveURL(/\?kind=plan$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Plan");
  await page.reload();
  await expect(page.getByRole("button", { name: "種類: Plan" })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "種類: Plan" }).click();
  await page.getByRole("menuitemradio", { name: "すべて" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(rows).toHaveCount(4);
});

test("新規ドキュメントを作ると Markdown ファイルができ、Issue と相互に参照できる", async ({ page, nod }) => {
  await page.goto("/documents");
  await page.getByRole("button", { name: "新規ドキュメント" }).click();
  await expect(page).toHaveURL(/\/documents\/new$/);
  await expect(page.getByText(`${docsDir(nod.dir)}/`)).toBeVisible();
  await page.getByLabel("相対パス").fill("specs/new-cache.md");
  await page.getByLabel("タイトル").fill("キャッシュの設計");
  await page.getByLabel("種類").selectOption("spec");
  await page.getByLabel("本文").fill("## 背景\n\n遅い\n");
  await page.getByLabel("リンク先 Issue").fill("api-12");
  await page.getByLabel("リンク先 Issue").press("Enter");
  await expect(page.getByRole("button", { name: "API-12 を外す" })).toBeVisible();
  await page.getByRole("button", { name: "作成", exact: true }).click();

  await expect(page).toHaveURL(/\/documents\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: "キャッシュの設計" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "背景" })).toBeVisible();
  const links = region(page, "関連 Issue");
  await expect(links.getByRole("link", { name: MAIN_TITLE })).toBeVisible();
  expect(readFileSync(join(docsDir(nod.dir), "specs", "new-cache.md"), "utf8")).toBe("# キャッシュの設計\n\n## 背景\n\n遅い\n");

  await links.getByRole("link", { name: MAIN_TITLE }).click();
  await expect(region(page, "Documents").getByRole("link", { name: "キャッシュの設計" })).toBeVisible();
  await expect(region(page, "Documents")).toContainText("添付者: me");
});

test.describe("作成の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of (400|404|409)/] });

  test("ルートの外・既存ファイル・存在しない Issue は理由を出し、ファイルを書き換えない", async ({ page, nod }) => {
    await page.goto("/documents/new");
    await page.getByLabel("相対パス").fill("../escape.md");
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("..");
    expect(existsSync(join(nod.dir, "escape.md"))).toBe(false);

    await page.getByLabel("相対パス").fill("x.md");
    await page.getByLabel("リンク先 Issue").fill("API-999");
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("API-999");
    expect(existsSync(join(docsDir(nod.dir), "x.md"))).toBe(false);

    mkdirSync(docsDir(nod.dir), { recursive: true });
    writeFileSync(join(docsDir(nod.dir), "x.md"), "元の本文\n");
    await page.getByRole("button", { name: "API-999 を外す" }).click();
    await page.getByRole("button", { name: "作成", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("既に同名のファイルがあります（x.md）");
    await expect(page.getByLabel("相対パス")).toHaveAttribute("aria-invalid", "true");
    expect(readFileSync(join(docsDir(nod.dir), "x.md"), "utf8")).toBe("元の本文\n");
    await expect(page).toHaveURL(/\/documents\/new$/);
  });
});

test("Issue 詳細の「新規作成」は Issue をリンク先に入れた作成画面を開き、キャンセルで戻る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  await page.getByRole("button", { name: "Documentを追加" }).click();
  await page.getByRole("menuitem", { name: "新規作成" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?issue=API-12$/);
  await expect(page.getByRole("button", { name: "API-12 を外す" })).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${ISSUE.main}$`));
});

test("Document 側から Issue をリンク・解除すると Issue 詳細にも反映する", async ({ page, nod }) => {
  await page.goto(`/documents/${DOC.spec}`);
  const links = region(page, "関連 Issue");
  await expect(links.getByText(ISSUE.main, { exact: true })).toBeVisible();
  await links.getByRole("button", { name: "Issue をリンク" }).click();
  await links.getByLabel("リンクする Issue ID").fill(ISSUE.empty.toLowerCase());
  await links.getByRole("button", { name: "リンク", exact: true }).click();
  await expect(links.getByText(ISSUE.empty, { exact: true })).toBeVisible();
  expect((await nod.me.getIssue(ISSUE.empty)).documents.map((d) => d.id)).toEqual([DOC.spec]);

  await links.getByRole("button", { name: `${ISSUE.main} のリンクを解除` }).click();
  await expect(links.getByText(ISSUE.main, { exact: true })).toHaveCount(0);
  const activity = (await nod.me.getIssue(ISSUE.main)).activity.map((a) => ("type" in a ? a.type : null));
  expect(activity).toContain("document_detached");

  await page.goto(`/issues/${ISSUE.empty}`);
  const docs = region(page, "Documents");
  await docs.getByRole("button", { name: "検索 API の高速化 設計 の添付を解除" }).click();
  await expect(docs.getByText("Document はありません")).toBeVisible();
  await page.goto(`/documents/${DOC.spec}`);
  await expect(region(page, "関連 Issue").getByText(ISSUE.empty, { exact: true })).toHaveCount(0);
});

test.describe("リンクの失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("存在しない Issue ID は理由を出し、入力を残す", async ({ page }) => {
    await page.goto(`/documents/${DOC.spec}`);
    const links = region(page, "関連 Issue");
    await links.getByRole("button", { name: "Issue をリンク" }).click();
    await links.getByLabel("リンクする Issue ID").fill("API-999");
    await links.getByRole("button", { name: "リンク", exact: true }).click();
    await expect(links.getByRole("alert")).toContainText("API-999");
    await expect(links.getByLabel("リンクする Issue ID")).toHaveValue("API-999");
  });
});
