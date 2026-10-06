import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ghCalls, stubGhBy } from "./support/nod";

// nod の Issue を GitHub Issue として作成する。e2e の server は実際の gh の代わりに stub の結果を返す（GitHub には触れない）
const CREATED = `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ number: 41, html_url: "https://github.com/example/api-server/issues/41" })}`;

test("検出で止まり、直すと作成でき、GitHub の行にリンクが出て、もう作成できない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await nod.me.setWorkspaceGithubRepo("API", "example/api-server");
  const issue = await api.startedIssue("検索を速くする");
  await nod.me.updateIssue(issue.id, { description: `${issue.id} の続き` });
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
  const findings = dialog.getByRole("group", { name: "nod の情報の検出結果" });
  await expect(findings.getByText("本文 1 行 1 桁")).toBeVisible();
  const send = dialog.getByRole("button", { name: "GitHub に作成する" });
  await expect(send).toBeDisabled();

  await dialog.getByLabel("本文").fill("続きの作業");
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
  expect((await nod.me.getIssue(issue.id)).description).toBe(`${issue.id} の続き`);

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
