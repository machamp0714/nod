import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { orcaCalls, stubOrca } from "./support/nod";

// Orca で作業を始める（#210）。e2e の server は実際の orca の代わりに stubOrca の結果を返す（Orca には触れず、worktree も作らない）
const ok = (result: unknown) => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });

test("実行場所が未記録の Issue で「Orca で作業を始める」から worktree を作ると、実行場所が記録されて「Orca で開く」に変わる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "Orca で worktree を作成" });
  const worktree = `${nod.dir}/orca/${created.id}-search-n1`;
  await stubOrca({}); // orca が無い
  await page.goto(`/issues/${created.id}`);
  const props = region(page, "プロパティ");
  const row = props.locator("dl > div").filter({ has: page.locator("dt", { hasText: "実行場所" }) });
  await expect(row.getByRole("button", { name: "Orca で開く" })).toHaveCount(0);
  const start = row.getByRole("button", { name: "Orca で作業を始める" });
  await start.click();
  expect((await row.boundingBox())?.height).toBe(28);

  // feature 名の初期値はタイトルの英数字の語。英小文字・数字・- 以外は入らず、空欄の間は作成できない
  const popover = page.getByRole("dialog", { name: "Orca で作業を始める" });
  const feature = popover.getByLabel("feature 名");
  const submit = popover.getByRole("button", { name: "作成して起動" });
  await expect(feature).toHaveValue("orca-worktree");
  await expect(feature).toBeFocused();
  await expect(popover.getByText(`${created.id}+orca-worktree`)).toBeVisible();
  await feature.fill("");
  await expect(submit).toBeDisabled();
  await feature.fill("Search N+1_検索");
  await expect(feature).toHaveValue("searchn1");
  await feature.fill("search-n1");
  await expect(popover.getByText(`${created.id}+search-n1`)).toBeVisible();
  // ポップオーバーはボタンの直下に開き、Main にも画面にもはみ出さない
  const fit = await popover.evaluate((el) => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const button = document.querySelector('button[aria-expanded="true"][aria-haspopup="dialog"]')!.getBoundingClientRect();
    return { width: r.width, left: r.left >= main.left, right: r.right <= main.right, below: r.top >= button.bottom };
  });
  expect(fit).toEqual({ width: 300, left: true, right: true, below: true });

  // 失敗したら理由をポップオーバーの上に出し、入力を残す。Issue は変わらない
  await submit.click();
  await expect(popover.getByRole("alert")).toHaveText("作成できませんでした：orca が見つかりません。Orca を起動し、orca CLI を使えるようにしてください");
  await expect(feature).toHaveValue("search-n1");
  expect((await api.show(created.id)).worktree).toBeNull();

  // 作成中は入力とボタンを無効にし、ラベルを「作成中…」にする
  await stubOrca({ "worktree create": ok({ worktree: { path: worktree, branch: "refs/heads/machamp0714/API-1-search-n1" }, agentTerminalHandle: "term_new" }) });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/issues/*/orca-worktree", async (route) => { await held; await route.continue(); });
  await submit.click();
  const creating = popover.getByRole("button", { name: "作成中…" });
  await expect(creating).toBeDisabled();
  await expect(feature).toBeDisabled();
  await expect(popover.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  await expect(popover.getByRole("alert")).toHaveCount(0);
  release();

  // 成功したら閉じ、行が「ブランチ · worktree」と「Orca で開く」に変わる。orca は決まった引数で1回だけ呼ばれる
  await expect(popover).toHaveCount(0);
  await expect(row.locator("dd")).toContainText(`machamp0714/API-1-search-n1 · ${worktree}`);
  await expect(row.getByRole("button", { name: "Orca で開く" })).toBeVisible();
  await expect(start).toHaveCount(0);
  expect(await orcaCalls()).toEqual([
    ["worktree", "create", "--repo", `path:${api.repo}`, "--name", `${created.id}+search-n1`, "--no-parent", "--agent", "claude",
      "--prompt", `nod の Issue ${created.id} に着手してください`, "--activate", "--json"],
  ]);
  const issue = await api.show(created.id);
  expect({ worktree: issue.worktree, branch: issue.branch, status: issue.status, assignee: issue.assignee }).toEqual({
    worktree, branch: "machamp0714/API-1-search-n1", status: created.status, assignee: created.assignee,
  });
});
