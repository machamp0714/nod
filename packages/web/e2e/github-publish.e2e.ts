import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ghCalls, stubGhBy } from "./support/nod";

// nod の Issue を GitHub Issue として作成する。e2e の server は実際の gh の代わりに stub の結果を返す（GitHub には触れない）
const CREATED = `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ number: 41, html_url: "https://github.com/example/api-server/issues/41" })}`;

test("整えた案から始まり、残った箇所で止まり、nod の文面に戻せて、直すと作成でき、GitHub の行にリンクが出て、もう作成できない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await nod.me.setWorkspaceGithubRepo("API", "example/api-server");
  const issue = await api.startedIssue("検索を速くする");
  const original = `${issue.id} の続き。#12 も見る`;
  const draft = "この Issue の続き。#12 も見る";
  await nod.me.updateIssue(issue.id, { description: original });
  await stubGhBy({
    "github.com user": { kind: "exited", exitCode: 0, stdout: "alice\n", stderr: "" },
    "-X POST": { kind: "exited", exitCode: 0, stdout: CREATED, stderr: "" },
  });
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Issueのメニュー" }).click();
  await page.getByRole("menuitem", { name: "GitHub に Issue を作成" }).click();

  const dialog = page.getByRole("dialog", { name: "GitHub に Issue を作成" });
  await expect(dialog.getByText("example/api-server")).toBeVisible();
  await expect(dialog.getByText("alice")).toBeVisible();
  const body = dialog.getByLabel("本文");
  // 自身の ID は「この Issue」に整えた案が入り、整えた箇所を元の文面の位置で示す
  await expect(body).toHaveValue(draft);
  const changes = dialog.getByRole("group", { name: "GitHub 向けに整えた箇所" });
  await expect(changes).toContainText("GitHub 向けに整えた箇所（1 件）");
  await expect(changes.getByText("本文 1 行 1 桁")).toBeVisible();
  await expect(changes.getByText("この Issue", { exact: true })).toBeVisible();
  await expect(changes.getByText(issue.id, { exact: true })).toBeVisible();
  // 参照先の repo が決まらない #12 は残り、送れない
  const findings = dialog.getByRole("group", { name: "nod の情報の検出結果" });
  await expect(findings.getByText("#12", { exact: true })).toBeVisible();
  await expect(findings.getByText(issue.id, { exact: true })).toHaveCount(0);
  const send = dialog.getByRole("button", { name: "GitHub に作成する" });
  await expect(send).toBeDisabled();

  // nod の文面に戻すと、自身の ID も検出され、送れない。整えた箇所は画面の文面と合わないので出さない
  await dialog.getByRole("button", { name: "nod の文面に戻す" }).click();
  await expect(body).toHaveValue(original);
  await expect(changes).toHaveCount(0);
  await expect(findings.getByText(issue.id, { exact: true })).toBeVisible();
  await expect(findings.getByText("#12", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();

  // 整えた案に戻すと、案の文面・整えた箇所・検出に戻る
  await dialog.getByRole("button", { name: "整えた案に戻す" }).click();
  await expect(body).toHaveValue(draft);
  await expect(changes.getByText("本文 1 行 1 桁")).toBeVisible();
  await expect(findings.getByText(issue.id, { exact: true })).toHaveCount(0);
  await expect(findings.getByText("#12", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();

  // 手で直すと、案と違う本文の整えた箇所は出さない
  await body.fill("この Issue の続き");
  await expect(changes).toHaveCount(0);
  await expect(findings).toHaveCount(0);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(dialog).toHaveCount(0);

  const github = region(page, "プロパティ").getByRole("group", { name: "GitHub" });
  await expect(github.getByRole("link", { name: "example/api-server#41" })).toHaveAttribute("href", "https://github.com/example/api-server/issues/41");
  expect((await ghCalls()).filter((a) => a.includes("POST"))).toHaveLength(1);
  // 作成した試行があるので、解除の確認は再公開できないと伝える
  await github.getByRole("button", { name: "解除" }).click();
  await expect(github.getByRole("alertdialog", { name: "紐付けを外す確認" })).toContainText("外しても再公開はできません");
  await github.getByRole("button", { name: "やめる" }).click();

  // nod の本文は変わらない
  expect((await nod.me.getIssue(issue.id)).description).toBe(original);

  // もう一度開くと、すでに対応している理由を出して送れない
  await page.getByRole("button", { name: "Issueのメニュー" }).click();
  await page.getByRole("menuitem", { name: "GitHub に Issue を作成" }).click();
  await expect(dialog.getByText("すでに https://github.com/example/api-server/issues/41 に対応しています")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "GitHub に作成する" })).toBeDisabled();
});

test.describe("記録の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("作成できたが nod に記録できなかったときは、作成の失敗ではなく作成済みの URL と紐付けの案内を出す", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    await nod.me.setWorkspaceGithubRepo("API", "example/api-server");
    const issue = await api.startedIssue("検索を速くする");
    await stubGhBy({ "github.com user": { kind: "exited", exitCode: 0, stdout: "alice\n", stderr: "" } });
    const url = "https://github.com/example/api-server/issues/41";
    let posts = 0;
    await page.route("**/api/issues/*/github/publish", (route) => {
      posts += 1;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "GITHUB_RECORD_FAILED", message: `GitHub Issue ${url} は作成しましたが、nod への記録に失敗しました`, details: { url } } }),
      });
    });
    await page.goto(`/issues/${issue.id}`);
    await page.getByRole("button", { name: "Issueのメニュー" }).click();
    await page.getByRole("menuitem", { name: "GitHub に Issue を作成" }).click();

    const dialog = page.getByRole("dialog", { name: "GitHub に Issue を作成" });
    await dialog.getByRole("button", { name: "GitHub に作成する" }).click();
    await expect(dialog.getByRole("link", { name: url })).toHaveAttribute("href", url);
    await expect(dialog.getByText("「紐付ける」にこの URL を入力してください")).toBeVisible();
    await expect(dialog.getByText("作成できませんでした")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "GitHub に作成する" })).toHaveCount(0);
    expect(posts).toBe(1);
  });
});
