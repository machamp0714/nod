import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const attachmentsDir = (dir: string) => join(dir, "attachments");
// 1x1 の PNG（本物の画像としてデコードできる）
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function writeBinary(dir: string, name: string, data: Buffer | string): string {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  const path = join(src, name);
  writeFileSync(path, data);
  return path;
}

async function naturalWidth(page: Page, name: string): Promise<number> {
  return page.getByRole("img", { name }).evaluate((img: HTMLImageElement) => img.naturalWidth);
}

test("Issue 詳細で画像と録画をサムネイルで並べ、拡大表示で前後に移り、再生できないものはダウンロードに回す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "画面を確かめる" });
  const dir = attachmentsDir(nod.dir);
  await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "before.png", PNG), dir });
  await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "result.log", "ok\n"), dir });
  await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "after.png", PNG), title: "修正後", dir });
  await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "demo.mp4", "not a video"), dir });

  await page.goto(`/issues/${issue.id}`);
  const section = page.getByRole("region", { name: "Attachments" });
  const grid = section.getByRole("list", { name: "添付メディア" });
  // メディアだけがサムネイルになり、log は一覧の行だけ
  await expect(grid.getByRole("button")).toHaveCount(3);
  await expect(grid.getByRole("button", { name: "result.log を拡大表示" })).toHaveCount(0);
  await expect(grid.getByRole("button", { name: "demo.mp4 を拡大表示" })).toContainText("MP4");
  await expect(section.getByRole("link", { name: "before.png" })).toHaveAttribute("download", "before.png");

  await grid.getByRole("button", { name: "before.png を拡大表示" }).click();
  const box = page.getByRole("dialog", { name: "before.png" });
  await expect(box).toBeVisible();
  await expect(box.getByRole("img", { name: "before.png" })).toHaveAttribute("src", /\/api\/attachments\/\d+\/view$/);
  await expect.poll(() => naturalWidth(page, "before.png")).toBe(1);
  await expect(box.getByText("1 / 3")).toBeVisible();
  await expect(box.getByRole("link", { name: "ダウンロード" })).toHaveAttribute("href", /\/api\/attachments\/\d+\/download$/);

  // → と「次の添付」で進み、最後から先頭に戻る
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "修正後" })).toBeVisible();
  await expect(page.getByText("2 / 3")).toBeVisible();
  await page.getByRole("button", { name: "次の添付" }).click();
  const video = page.getByRole("dialog", { name: "demo.mp4" });
  await expect(video.getByText("3 / 3")).toBeVisible();
  // 中身が動画でないので再生できず、ダウンロードを案内する
  await expect(video.getByRole("alert")).toContainText("プレビューを表示できません");
  await expect(video.getByRole("alert")).toContainText("demo.mp4 · 11 B");
  await expect(video.getByRole("alert").getByRole("link", { name: "ダウンロード" })).toBeVisible();
  await page.getByRole("button", { name: "次の添付" }).click();
  await expect(page.getByText("1 / 3")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText("3 / 3")).toBeVisible();

  // Esc と × で閉じる
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await grid.getByRole("button", { name: "修正後 を拡大表示" }).click();
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("画像は inline、それ以外は attachment で配信する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "配信" });
  const dir = attachmentsDir(nod.dir);
  const png = await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "a.png", PNG), dir });
  const log = await nod.claude.addFileAttachment(issue.id, { path: writeBinary(nod.dir, "a.log", "x"), dir });
  const image = await page.request.get(`/api/attachments/${png.id}/view`);
  expect(image.headers()["content-disposition"]).toMatch(/^inline;/);
  expect(image.headers()["x-content-type-options"]).toBe("nosniff");
  expect(image.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
  const other = await page.request.get(`/api/attachments/${log.id}/view`);
  expect(other.headers()["content-disposition"]).toMatch(/^attachment;/);
});

test("Reviews で変更ファイルの前に添付メディアを出し、拡大表示できる。メディアがなければ出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const dir = attachmentsDir(nod.dir);
  const a = await api.inReview("録画付きのレビュー", "画面を直した", "https://github.com/example/api-server/pull/7");
  await nod.claude.addFileAttachment(a.id, { path: writeBinary(nod.dir, "screen.png", PNG), dir });
  await nod.claude.addFileAttachment(a.id, { path: writeBinary(nod.dir, "demo.webm", "not a video"), dir });
  const b = await api.inReview("添付なしのレビュー", "文言を直した", "https://github.com/example/api-server/pull/8");

  await page.goto(`/reviews?selected=${a.id}`);
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  const media = detail.getByRole("region", { name: "添付メディア" });
  await expect(media.getByRole("heading", { name: "添付メディア" })).toBeVisible();
  await expect(media.getByText("2", { exact: true })).toBeVisible();
  // 変更ファイルの直前に並ぶ
  const order = await detail.getByRole("region").evaluateAll(els => els.map(e => e.getAttribute("aria-label")));
  expect(order.indexOf("添付メディア")).toBe(order.indexOf("変更ファイル") - 1);
  await expect(media.getByRole("button", { name: "demo.webm を拡大表示" })).toContainText("WEBM");

  await media.getByRole("button", { name: "screen.png を拡大表示" }).click();
  await expect(page.getByRole("dialog", { name: "screen.png" })).toBeVisible();
  await expect.poll(() => naturalWidth(page, "screen.png")).toBe(1);
  await page.keyboard.press("Escape");

  // 折りたためる
  await media.getByRole("button", { name: "添付メディアを閉じる" }).click();
  await expect(media.getByRole("list", { name: "添付メディア" })).toHaveCount(0);

  await page.goto(`/reviews?selected=${b.id}`);
  await expect(detail.getByRole("heading", { name: "添付なしのレビュー" })).toBeVisible();
  await expect(detail.getByRole("region", { name: "添付メディア" })).toHaveCount(0);
});
