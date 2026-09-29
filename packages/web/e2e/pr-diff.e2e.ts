import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { ghCalls, releaseGh, stubGh, stubGhBy } from "./support/nod";

// PR の変更ファイルと差分（#55）。e2e の server は実際の gh の代わりに stubGhBy の結果を返す（GitHub には触れない）
const PR_URL = "https://github.com/example/api-server/pull/214";
const HEAD = "abc1234".padEnd(40, "0");
const HEAD2 = "def5678".padEnd(40, "0");
const BASE = "c".repeat(40);
const ok = (stdout: string) => ({ kind: "exited" as const, exitCode: 0, stdout, stderr: "" });
// gh pr view の出力。差分（headRefOid・baseRefOid・changedFiles）と PR 状態（#67）の両方の項目を持たせる
const view = (head = HEAD, changedFiles = 7) =>
  JSON.stringify({
    headRefOid: head,
    baseRefOid: BASE,
    changedFiles,
    number: 214,
    title: "t",
    url: PR_URL,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergedAt: null,
    statusCheckRollup: [],
  });

const XSS_PATH = `src/<img src=x onerror="window.__xss=1">.ts`;
const DIFF = [
  "diff --git a/internal/webhook/verify.go b/internal/webhook/verify.go",
  "--- a/internal/webhook/verify.go",
  "+++ b/internal/webhook/verify.go",
  "@@ -40,3 +40,4 @@ func Verify() error {",
  '   sig := r.Header.Get("X-Signature")',
  "-  if sig == \"\" { return nil }",
  "+  if sig == \"\" {",
  "+    return ErrMissingSignature",
  "   mac.Write(body)",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1 @@",
  "+<script>window.__xss=1</script>",
  "diff --git a/internal/webhook/handler.go b/internal/webhook/receiver.go",
  "similarity index 100%",
  "rename from internal/webhook/handler.go",
  "rename to internal/webhook/receiver.go",
  "diff --git a/legacy.go b/legacy.go",
  "deleted file mode 100644",
  "--- a/legacy.go",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-package legacy",
  "diff --git a/docs/flow.png b/docs/flow.png",
  "Binary files a/docs/flow.png and b/docs/flow.png differ",
  `diff --git a/${XSS_PATH} b/${XSS_PATH}`,
  `--- a/${XSS_PATH}`,
  `+++ b/${XSS_PATH}`,
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1 +1 @@",
  "-const role = 'user';",
  "+const role = 'user\u202e \u2066// admin\u2069';",
  "diff --git a/big.sql b/big.sql",
  "--- a/big.sql",
  "+++ b/big.sql",
  "@@ -0,0 +1,5001 @@",
  ...Array(5001).fill("+x"),
  "",
].join("\n");

async function issueWithPr(nod: Parameters<typeof seedApiWorkspace>[0]) {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("決済 Webhook の署名検証を追加");
  await nod.claude.completeIssue(issue.id, { summary: "署名を検証した", prUrl: PR_URL });
  return issue.id;
}

const section = (page: Page) => page.getByRole("region", { name: "変更ファイル" });
const refreshButton = (page: Page) => section(page).getByRole("button", { name: "変更ファイルを更新" });
const fileRow = (page: Page, name: string | RegExp) => section(page).getByRole("button", { name });
// ファイルごとの patch の取得（GET /api/issues/:id/pr-diff/files?path=...）を数える
function countFileRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith("/pr-diff/files")) paths.push(url.searchParams.get("path") ?? "");
  });
  return paths;
}

test("未取得なら gh を実行せず、更新すると HEAD に固定した差分を取得して、ファイルごとに開ける", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) }, { gate: true });
  await page.goto(`/issues/${id}`);
  await expect(section(page).getByText("未取得。更新で gh から取得します")).toBeVisible();
  expect(await ghCalls()).toEqual([]);

  await refreshButton(page).click();
  await expect(section(page).getByText("取得中…")).toBeVisible();
  await expect(refreshButton(page)).toBeDisabled();
  await releaseGh();

  await expect(section(page).getByText("HEAD abc1234", { exact: true })).toBeVisible();
  await expect(section(page).getByText("取得: たった今")).toBeVisible();
  await expect(section(page).getByRole("link", { name: "GitHub で開く ↗" })).toHaveAttribute("href", `${PR_URL}/files`);
  expect(await ghCalls()).toEqual([
    ["pr", "view", PR_URL, "--json", "headRefOid,baseRefOid,changedFiles"],
    ["api", "--hostname", "github.com", "-H", "Accept: application/vnd.github.diff", `repos/example/api-server/compare/${BASE}...${HEAD}`],
  ]);

  // 最初の5件だけを出し、残りは「他 N ファイルを表示」で出す
  const list = section(page).getByRole("list", { name: "変更ファイルの一覧" });
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await expect(fileRow(page, /^変更 internal\/webhook\/verify\.go/)).toBeVisible();
  await expect(fileRow(page, /^追加 docs\/new\.md/)).toBeVisible();
  await expect(fileRow(page, /^名前変更 internal\/webhook\/handler\.go → internal\/webhook\/receiver\.go/)).toBeVisible();
  await expect(fileRow(page, /^削除 legacy\.go/)).toBeVisible();
  await expect(fileRow(page, /^バイナリ docs\/flow\.png バイナリ/)).toBeVisible();
  await section(page).getByRole("button", { name: "他 3 ファイルを表示" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(8);

  const verify = fileRow(page, /^変更 internal\/webhook\/verify\.go/);
  await expect(verify).toHaveAttribute("aria-expanded", "false");
  await verify.click();
  await expect(verify).toHaveAttribute("aria-expanded", "true");
  const table = section(page).getByRole("table", { name: "internal/webhook/verify.go の差分" });
  await expect(table.getByRole("row")).toHaveCount(6);
  await expect(table.getByRole("row").nth(0)).toHaveText("@@ -40,3 +40,4 @@ func Verify() error {");
  await expect(table.getByRole("row").nth(2)).toHaveText(`41-  if sig == "" { return nil }`);
  await expect(table.getByRole("row").nth(3)).toHaveText(`41+  if sig == "" {`);

  await fileRow(page, /^バイナリ docs\/flow\.png/).click();
  await expect(section(page).getByText("バイナリのため表示しません")).toBeVisible();
  await fileRow(page, /^変更 big\.sql/).click();
  await expect(section(page).getByText("大きいため省略しました。GitHub で確認してください")).toBeVisible();

  await page.reload();
  await expect(section(page).getByText("HEAD abc1234", { exact: true })).toBeVisible();
  expect((await nod.me.getPrDiff(id)).diff).toMatchObject({ headSha: HEAD, fetchedBy: "me" });
});

test("差分・パスに含まれる HTML は文字として表示し、要素にしない", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  await section(page).getByRole("button", { name: "他 3 ファイルを表示" }).click();
  await fileRow(page, /^追加 docs\/new\.md/).click();
  await expect(section(page).getByText("<script>window.__xss=1</script>")).toBeVisible();
  const xss = fileRow(page, `変更 ${XSS_PATH} +1 −1`);
  await xss.click();
  await expect(xss).toContainText(XSS_PATH);
  await expect(section(page).locator("script, img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("一覧は patch を読まず、開いたファイルだけを読み、無関係な更新では読み直さない", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  const files = countFileRequests(page);
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  await expect(fileRow(page, /^変更 internal\/webhook\/verify\.go/)).toBeVisible();
  // 閉じたまま・バイナリを開いても patch は読まない
  await fileRow(page, /^バイナリ docs\/flow\.png/).click();
  await expect(section(page).getByText("バイナリのため表示しません")).toBeVisible();
  expect(files).toEqual([]);

  await fileRow(page, /^変更 internal\/webhook\/verify\.go/).click();
  await expect(section(page).getByRole("table", { name: "internal/webhook/verify.go の差分" })).toBeVisible();
  expect(files).toEqual(["internal/webhook/verify.go"]);

  // 別の書き込み（PR 状態の更新。HEAD は同じ）ですべてのクエリが無効になっても、開いたファイルの patch は読み直さない
  const summary = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/pr-diff") && r.request().method() === "GET");
  await page.getByRole("button", { name: "PR の状態を更新" }).click();
  await summary;
  await expect(section(page).getByRole("table", { name: "internal/webhook/verify.go の差分" })).toBeVisible();
  expect(files).toEqual(["internal/webhook/verify.go"]);

  // 差分を取り直すと、開いているファイルは新しい取得の patch を読む
  await refreshButton(page).click();
  await expect.poll(() => files).toEqual(["internal/webhook/verify.go", "internal/webhook/verify.go"]);
});

test("双方向の制御文字は符号で見せ、注意を出す", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  await section(page).getByRole("button", { name: "他 3 ファイルを表示" }).click();
  await fileRow(page, /^変更 src\/auth\.ts/).click();
  await expect(section(page).getByRole("note")).toContainText("双方向の制御文字を含みます");
  const table = section(page).getByRole("table", { name: "src/auth.ts の差分" });
  await expect(table.getByRole("row").nth(2)).toHaveText("1+const role = 'user⟪U+202E⟫ ⟪U+2066⟫// admin⟪U+2069⟫';");
  expect(await table.textContent()).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
});

test("失敗は理由を出し、前回の差分は残す。前回がなければ理由だけを出す", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGh({ kind: "exited", exitCode: 4, stdout: "", stderr: "gh auth login" });
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  await expect(section(page).getByRole("alert")).toHaveText("gh が未認証です。gh auth login を実行してください");

  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  await refreshButton(page).click();
  await expect(section(page).getByRole("alert")).toHaveCount(0);
  await stubGhBy({ pr: ok(view()), api: { kind: "timeout" } });
  await refreshButton(page).click();
  await expect(section(page).getByRole("alert")).toContainText("差分を取得できませんでした：");
  await expect(fileRow(page, /^変更 internal\/webhook\/verify\.go/)).toBeVisible();
});

test("変更ファイルが多すぎると GitHub で確認するよう案内する", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view(HEAD, 312)), api: ok(DIFF) });
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  const box = section(page).getByRole("status");
  await expect(box).toContainText("差分が大きすぎます。GitHub で確認してください");
  await expect(box.getByRole("link", { name: "GitHub で開く ↗" })).toHaveAttribute("href", `${PR_URL}/files`);
  expect(await ghCalls()).toHaveLength(1);
});

test("PR 状態の取得で HEAD が変わったと分かったら、古い差分を出さずに更新を促す", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  await page.goto(`/issues/${id}`);
  await refreshButton(page).click();
  await expect(fileRow(page, /^変更 internal\/webhook\/verify\.go/)).toBeVisible();

  await stubGhBy({ pr: ok(view(HEAD2)), api: ok(DIFF) });
  await page.getByRole("button", { name: "PR の状態を更新" }).click();
  await expect(section(page).getByRole("status")).toHaveText("PR が更新されています（HEAD abc1234 → def5678）。差分を更新してください");
  await expect(section(page).getByRole("list", { name: "変更ファイルの一覧" })).toHaveCount(0);
  await expect(section(page).getByText("HEAD abc1234", { exact: true })).toBeVisible();

  await refreshButton(page).click();
  await expect(section(page).getByText("HEAD def5678", { exact: true })).toBeVisible();
  await expect(section(page).getByRole("status")).toHaveCount(0);
  await expect(fileRow(page, /^変更 internal\/webhook\/verify\.go/)).toBeVisible();
});

test("Reviews では PR カードの下に折りたたんで出し、開いて差分を見てから既存の操作で承認できる", async ({ page, nod }) => {
  const id = await issueWithPr(nod);
  await stubGhBy({ pr: ok(view()), api: ok(DIFF) });
  await page.goto("/reviews");
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  const diff = detail.getByRole("region", { name: "変更ファイル" });
  await expect(diff.getByText("未取得。更新で gh から取得します")).toBeVisible();
  await diff.getByRole("button", { name: "変更ファイルを更新" }).click();
  await expect(diff.getByText("HEAD abc1234", { exact: true })).toBeVisible();
  await expect(diff.getByRole("list", { name: "変更ファイルの一覧" })).toHaveCount(0);

  await diff.getByRole("button", { name: "変更ファイルを開く" }).click();
  await diff.getByRole("button", { name: /^変更 internal\/webhook\/verify\.go/ }).click();
  await expect(diff.getByRole("table", { name: "internal/webhook/verify.go の差分" })).toBeVisible();

  await detail.getByRole("button", { name: "承認して閉じる" }).click();
  await expect(page.getByRole("region", { name: "レビュー待ちの一覧" }).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  expect((await nod.me.getIssue(id)).status).toBe("done");
});
