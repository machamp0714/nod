import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test, waitForServerEvents } from "./fixtures";
import { ghCalls, stubGh } from "./support/nod";

// nod の承認と GitHub PR の関係（#56/#57）。nod の承認は GitHub へ何も書き込まず、gh も実行しない。
// e2e の server は実際の gh の代わりに stubGh の結果を返す（GitHub には触れない）
const PR_URL = "https://github.com/example/api-server/pull/128";
const NOTE = "nod の承認は GitHub の承認・マージではありません。GitHub には何も書き込みません";
const ghJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 128,
    title: "決済 Webhook の署名検証を追加",
    url: PR_URL,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    mergedAt: null,
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...over,
  });

const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });

async function reviewWithPr(nod: Parameters<typeof seedApiWorkspace>[0]) {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("決済 Webhook の署名検証を追加");
  await nod.claude.completeIssue(issue.id, { summary: "署名を検証した", prUrl: PR_URL });
  return issue.id;
}

test("Reviews: 未取得を示し、更新で GitHub の状態を並べ、未マージ・変更要求の注意を出しても承認でき、承認では gh を実行しない", async ({ page, nod }) => {
  const id = await reviewWithPr(nod);
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson(), stderr: "" });
  await page.goto("/reviews");
  const group = detail(page).getByRole("group", { name: "GitHub の状態" });
  await expect(group.getByText("GitHub の状態は未取得（更新で取得）")).toBeVisible();
  await expect(detail(page).getByText(NOTE)).toBeVisible();
  await expect(detail(page).getByRole("list", { name: "GitHub 側の注意" })).toHaveCount(0);
  await expect(detail(page).getByRole("link", { name: "GitHub で開く" })).toHaveAttribute("href", PR_URL);
  expect(await ghCalls()).toEqual([]);

  await group.getByRole("button", { name: "GitHub の状態を更新" }).click();
  await expect(group.getByText("Open", { exact: true })).toBeVisible();
  await expect(group.getByText("変更要求")).toBeVisible();
  await expect(group.getByLabel(/^CI /)).toHaveText("✓1");
  await expect(group.getByText("取得: たった今")).toBeVisible();
  const caution = detail(page).getByRole("list", { name: "GitHub 側の注意" });
  await expect(caution.getByRole("listitem")).toHaveText(["GitHub の PR はまだマージされていません（Open）", "GitHub で変更要求が出ています"]);
  expect(await ghCalls()).toHaveLength(1);

  // 注意と注記は承認ボタンの上、差し戻しの理由の下にある（nod.pen の Approval Area）
  const feedback = await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).boundingBox();
  const note = await detail(page).getByText(NOTE).boundingBox();
  const approveButton = detail(page).getByRole("button", { name: "承認して閉じる" });
  const button = await approveButton.boundingBox();
  expect(note!.y).toBeGreaterThan(feedback!.y);
  expect(button!.y).toBeGreaterThan(note!.y);

  await approveButton.click();
  await expect(page.getByText("レビュー待ちの Issue はありません").first()).toBeVisible();
  expect((await nod.me.getIssue(id)).status).toBe("done");
  expect(await ghCalls()).toHaveLength(1);
});

test("Reviews: マージ済み・承認済みなら注意を出さず、注記だけを出す", async ({ page, nod }) => {
  await reviewWithPr(nod);
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson({ state: "MERGED", reviewDecision: "APPROVED", mergedAt: "2026-09-29T01:00:00Z" }), stderr: "" });
  await page.goto("/reviews");
  const group = detail(page).getByRole("group", { name: "GitHub の状態" });
  await group.getByRole("button", { name: "GitHub の状態を更新" }).click();
  await expect(group.getByText("Merged", { exact: true })).toBeVisible();
  await expect(group.getByText("承認済み")).toBeVisible();
  await expect(detail(page).getByText(NOTE)).toBeVisible();
  await expect(detail(page).getByRole("list", { name: "GitHub 側の注意" })).toHaveCount(0);
});

test("Issue 詳細: In Review の親の完了候補バナーに注記と GitHub 側の注意を出し、承認では gh を実行しない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const parent = await api.startedIssue("レビュー中の親");
  const child = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "子", parentRef: parent.id });
  await nod.me.updateIssue(child.id, { status: "done" });
  await nod.claude.completeIssue(parent.id, { summary: "直した", prUrl: PR_URL });
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson({ reviewDecision: null }), stderr: "" });

  await page.goto(`/issues/${parent.id}`);
  await waitForServerEvents(page);
  const banner = page.getByRole("region", { name: "親の完了候補", exact: true });
  await expect(banner.getByText(NOTE)).toBeVisible();
  await expect(banner.getByRole("list", { name: "GitHub 側の注意" })).toHaveCount(0);

  await page.getByRole("group", { name: "PR 状態" }).getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(banner.getByRole("list", { name: "GitHub 側の注意" }).getByRole("listitem")).toHaveText(["GitHub の PR はまだマージされていません（Open）"]);
  expect(await ghCalls()).toHaveLength(1);

  await banner.getByRole("button", { name: "承認して完了" }).click();
  await expect(banner).toHaveCount(0);
  expect((await nod.me.getIssue(parent.id)).status).toBe("done");
  expect(await ghCalls()).toHaveLength(1);
});

test("Issue 詳細: In Review でない親の完了候補バナーには注記を出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const parent = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "作業中の親" });
  const child = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "子", parentRef: parent.id });
  await nod.me.updateIssue(child.id, { status: "done" });
  await page.goto(`/issues/${parent.id}`);
  await waitForServerEvents(page);
  const banner = page.getByRole("region", { name: "親の完了候補", exact: true });
  await expect(banner.getByRole("button", { name: "完了にする" })).toBeVisible();
  await expect(banner.getByText(NOTE)).toHaveCount(0);
});
