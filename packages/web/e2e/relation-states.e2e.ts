import { expect, test } from "./fixtures";
import { seedApiWorkspace } from "./decision-data";

// design/nod.pen「12 Issue 詳細｜関係の状態」（#203）
test("関連 Issue では、アーカイブ済みの相手と、数えないブロック元（完了・キャンセル）に印を付ける", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const make = (title: string) => nod.me.createIssue({ workspaceId: api.workspace.id, title });
  const target = await make("ブロックされる Issue");
  const archived = await make("アーカイブするブロック元");
  const done = await make("完了するブロック元");
  const canceled = await make("キャンセルするブロック元");
  const open = await make("残るブロック元");
  const related = await make("アーカイブする関連");
  for (const b of [archived, done, canceled, open]) await nod.me.relateIssue(b.id, { blocks: target.id });
  await nod.me.relateIssue(target.id, { related: related.id });
  await nod.me.archiveIssue(archived.id);
  await nod.me.archiveIssue(related.id);
  await nod.me.updateIssue(done.id, { status: "done" });
  await nod.me.updateIssue(canceled.id, { status: "canceled" });

  await page.goto(`/issues/${target.id}`);
  const relations = page.getByRole("region", { name: "関連 Issue" });
  const row = (label: string) => relations.locator("dt", { hasText: label }).locator("xpath=..");
  await expect(row("Blocked by")).toHaveText(`Blocked by${archived.id}アーカイブ済み${done.id}完了${canceled.id}キャンセル${open.id}`);
  await expect(row("Related")).toHaveText(`Related${related.id}アーカイブ済み`);
  // 印が付いてもリンクは残り、アーカイブ済みの相手の詳細へ移れる
  await expect(relations.getByRole("link", { name: archived.id, exact: true })).toHaveAttribute("href", `/issues/${archived.id}`);
  // 数えないブロック元の ID は淡色（--ink3）、数えるブロック元は今までどおり
  await expect(relations.getByRole("link", { name: done.id, exact: true })).toHaveCSS("color", "rgb(138, 145, 158)");
  await expect(relations.getByRole("link", { name: open.id, exact: true })).not.toHaveCSS("color", "rgb(138, 145, 158)");

  // ブロックしている側（Blocks）には、相手が完了でも印を付けない
  await nod.me.updateIssue(target.id, { status: "done" });
  await page.goto(`/issues/${open.id}`);
  await expect(page.getByRole("region", { name: "関連 Issue" })).toHaveText(new RegExp(`Blocks${target.id}$`));
});
