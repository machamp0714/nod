import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const attachmentsDir = (dir: string) => join(dir, "attachments");

test("Issue 詳細でリンクを追加・削除し、CLI で添付したファイルをダウンロードできる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "添付を確かめる" });
  const src = nod.writeFile("src/error.log", "boom\n");
  await nod.claude.addFileAttachment(issue.id, { path: src, dir: attachmentsDir(nod.dir) });

  await page.goto(`/issues/${issue.id}`);
  const section = page.getByRole("region", { name: "Attachments" });
  await expect(section.getByRole("heading", { name: "Attachments" })).toBeVisible();
  const file = section.getByRole("listitem").filter({ hasText: "error.log" });
  await expect(file).toContainText("5 B · claude-code ·");
  // 元ファイルの実体パスは Issue 詳細の Activity にだけ出る（監査用）
  await expect(page.getByText("claude-code がファイルを添付した：error.log")).toBeVisible();
  await expect(page.getByText(`元: ${realpathSync(src)}`)).toBeVisible();

  // web からはリンクだけを足せる。不正な URL は送らずに入力欄の下へ出す
  await section.getByRole("button", { name: "リンクを追加" }).click();
  await section.getByRole("textbox", { name: "URL" }).fill("javascript:alert(1)");
  await section.getByRole("button", { name: "追加", exact: true }).click();
  await expect(section.getByRole("alert")).toHaveText("http または https の URL を入力してください");
  await expect(section.getByRole("textbox", { name: "URL" })).toHaveAttribute("aria-invalid", "true");
  await section.getByRole("textbox", { name: "URL" }).fill("https://docs.google.com/document/d/1");
  await section.getByRole("textbox", { name: "タイトル（任意）" }).fill("設計レビュー議事録");
  await section.getByRole("button", { name: "追加", exact: true }).click();
  const link = section.getByRole("link", { name: "設計レビュー議事録" });
  await expect(link).toHaveAttribute("href", "https://docs.google.com/document/d/1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(section.getByRole("listitem").filter({ hasText: "設計レビュー議事録" })).toContainText("docs.google.com · me ·");
  await expect(section.getByText("2", { exact: true })).toBeVisible();
  await expect(page.getByText("me がリンクを添付した：設計レビュー議事録")).toBeVisible();

  // ファイルはダウンロードになる
  const downloadPromise = page.waitForEvent("download");
  await section.getByRole("link", { name: "error.log" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("error.log");
  expect(readFileSync(await download.path(), "utf8")).toBe("boom\n");

  // 削除するとリストから消え、ファイルのコピーも消える
  await section.getByRole("button", { name: "error.log を削除" }).click();
  await expect(section.getByRole("listitem")).toHaveCount(1);
  expect((await api.show(issue.id)).attachments.map((a: { kind: string }) => a.kind)).toEqual(["link"]);
  await section.getByRole("button", { name: "設計レビュー議事録 を削除" }).click();
  await expect(section.getByText("添付はありません")).toBeVisible();
});

test("アーカイブ済みの Issue では追加と削除ができず、ダウンロードはできる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "アーカイブ済みの添付" });
  await nod.me.addLinkAttachment(issue.id, { url: "https://github.com/a/b/pull/1" });
  await nod.me.archiveIssue(issue.id);

  await page.goto(`/issues/${issue.id}`);
  const section = page.getByRole("region", { name: "Attachments" });
  await expect(section.getByRole("link", { name: "github.com" })).toBeVisible();
  await expect(section.getByRole("button", { name: "リンクを追加" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "github.com を削除" })).toBeDisabled();
});
