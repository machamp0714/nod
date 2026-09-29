import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ghCalls, releaseGh, stubGh } from "./support/nod";

// PR 状態（#67）。e2e の server は実際の gh の代わりに stubGh の結果を返す（GitHub には触れない）
const PR_URL = "https://github.com/example/api-server/pull/214";
const ghJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 214,
    title: "検索 API の N+1 を解消",
    url: PR_URL,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    mergedAt: null,
    statusCheckRollup: [
      ...Array.from({ length: 5 }, (_, i) => ({ __typename: "CheckRun", name: `ok-${i}`, status: "COMPLETED", conclusion: "SUCCESS" })),
      { __typename: "CheckRun", name: "test / integration", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci.example/1" },
      { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
    ],
    ...over,
  });

async function issueWithPr(nod: Parameters<typeof seedApiWorkspace>[0], prUrl = PR_URL) {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索 API の N+1 を解消");
  await nod.claude.completeIssue(issue.id, { summary: "直した", prUrl });
  return issue.id;
}

const prStatus = (page: import("@playwright/test").Page) => region(page, "プロパティ").getByRole("group", { name: "PR 状態" });

test("未取得なら gh を実行せず、更新すると状態・レビュー・CI・取得時刻を表示して保存する", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson(), stderr: "" }, { gate: true });
  await page.goto(`/issues/${id}`);
  const group = prStatus(page);
  await expect(group.getByText("未取得")).toBeVisible();
  expect(await ghCalls()).toEqual([]);

  await group.getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(group.getByText("取得中…")).toBeVisible();
  await expect(group.getByRole("button", { name: "PR の状態を更新" })).toBeDisabled();
  await releaseGh();

  await expect(group.getByText("Open", { exact: true })).toBeVisible();
  await expect(group.getByText("変更要求")).toBeVisible();
  const ci = group.getByRole("button", { name: /^CI / });
  await expect(ci).toHaveText("✓5 ✗1 ⋯2");
  await expect(group.getByText("取得: たった今")).toBeVisible();
  expect(await ghCalls()).toEqual([
    ["pr", "view", PR_URL, "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergedAt"],
  ]);

  await expect(group.getByRole("list", { name: "失敗したチェック" })).toHaveCount(0);
  await ci.click();
  const failures = group.getByRole("list", { name: "失敗したチェック" });
  await expect(failures.getByRole("listitem")).toHaveText(["test / integration"]);
  await expect(failures.getByRole("link", { name: "test / integration" })).toHaveAttribute("href", "https://ci.example/1");

  await page.reload();
  await expect(prStatus(page).getByText("変更要求")).toBeVisible();
  expect((await nod.me.getPrStatus(id)).status).toMatchObject({ state: "OPEN", fetchedBy: "me" });
});

test("マージ済み・承認済み・CI 成功は緑と青のピルで出し、失敗の一覧は開けない", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGh({
    kind: "exited",
    exitCode: 0,
    stdout: ghJson({
      state: "MERGED",
      mergedAt: "2026-09-29T00:00:00Z",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    stderr: "",
  });
  await page.goto(`/issues/${id}`);
  await prStatus(page).getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(prStatus(page).getByText("Merged")).toBeVisible();
  await expect(prStatus(page).getByText("承認済み")).toBeVisible();
  await expect(prStatus(page).getByLabel(/^CI /)).toHaveText("✓1");
  await expect(prStatus(page).getByRole("button", { name: /^CI / })).toHaveCount(0);
});

test("取得に失敗したら前回の結果を薄く残し、理由を role=alert で出す", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson(), stderr: "" });
  await page.goto(`/issues/${id}`);
  const group = prStatus(page);
  await group.getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(group.getByText("変更要求")).toBeVisible();

  await stubGh({ kind: "exited", exitCode: 4, stdout: "", stderr: "" });
  await group.getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(group.getByRole("alert")).toHaveText("gh が未認証です。gh auth login を実行してください");
  await expect(group.getByTestId("pr-status-result")).toHaveCSS("opacity", "0.45");
  await expect(group.getByText("変更要求")).toBeVisible();
  await expect(group.getByText(/^取得: /)).toBeVisible();
});

const failures: [string, Parameters<typeof stubGh>[0], string][] = [
  ["gh 未導入", { kind: "not_found" }, "gh が見つかりません。GitHub CLI を導入してください"],
  ["PR 不存在", { kind: "exited", exitCode: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest" }, "PR が見つかりません（削除またはアクセス権なし）"],
  ["ネットワーク", { kind: "exited", exitCode: 1, stdout: "", stderr: "error connecting to api.github.com" }, "GitHub に接続できません"],
  ["タイムアウト", { kind: "timeout" }, "15秒以内に応答がありませんでした"],
];
for (const [label, result, message] of failures) {
  test(`前回の結果がない失敗はエラーだけを出す: ${label}`, async ({ page, nod }) => {
    const id = await issueWithPr(nod);
    await stubGh(result);
    await page.goto(`/issues/${id}`);
    const group = prStatus(page);
    await group.getByRole("button", { name: "PR の状態を更新" }).click();
    await expect(group.getByRole("alert")).toHaveText(message);
    await expect(group.getByText("未取得")).toBeVisible();
    await expect(group.getByTestId("pr-status-result")).toHaveCount(0);
    await expect(group.getByRole("button", { name: "PR の状態を更新" })).toBeEnabled();
  });
}

test("GitHub 以外の PR URL は gh を実行せずに理由を出す", async ({ page, nod }) => {
  const id = await issueWithPr(nod, "https://example.com/pr/1");
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghJson(), stderr: "" });
  await page.goto(`/issues/${id}`);
  await prStatus(page).getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(prStatus(page).getByRole("alert")).toHaveText("GitHub の PR URL ではありません");
  expect(await ghCalls()).toEqual([]);
});

test("PR の無い Issue は — だけを出し、更新ボタンを出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("PR なし");
  await page.goto(`/issues/${issue.id}`);
  await expect(region(page, "プロパティ").getByRole("group", { name: "PR 状態" })).toHaveCount(0);
  await expect(region(page, "プロパティ").getByRole("button", { name: "PR の状態を更新" })).toHaveCount(0);
});
