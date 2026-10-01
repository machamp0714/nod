import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { orcaCalls, stubOrca } from "./support/nod";

// Orca で開く（#52）。e2e の server は実際の orca の代わりに stubOrca の結果を返す（Orca には触れない）
const ok = (result: unknown) => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });

test("実行場所の行の「Orca で開く」で、worktree の LLM の端末を前面に出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索 API の N+1 を解消");
  await stubOrca({
    "terminal list": ok({ terminals: [{ handle: "term_a", title: "claude", worktreePath: api.repo, connected: true, writable: true, agentIdentity: "claude" }] }),
    "terminal switch": ok({}),
  });
  await page.goto(`/issues/${issue.id}`);
  await region(page, "プロパティ").getByRole("button", { name: "Orca で開く" }).click();
  await expect.poll(orcaCalls).toEqual([
    ["terminal", "list", "--worktree", `path:${api.repo}`, "--json"],
    ["terminal", "switch", "--terminal", "term_a", "--json"],
  ]);
  await expect(page.getByRole("dialog", { name: "Orca で開けませんでした" })).toHaveCount(0);
});

test("開けないときは理由を出し、パスと cd コマンドをコピーできる", async ({ page, nod, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索 API の N+1 を解消");
  await stubOrca({}); // orca が無い
  await page.goto(`/issues/${issue.id}`);
  const props = region(page, "プロパティ");
  await props.getByRole("button", { name: "Orca で開く" }).click();
  const popover = page.getByRole("dialog", { name: "Orca で開けませんでした" });
  await expect(popover.getByRole("alert")).toContainText("Orca で開けませんでした：orca が見つかりません");
  await expect(popover.getByRole("alert")).toContainText(api.repo);
  // ボタンは行の右端にあるため、ポップオーバーは左へ開く。Main にも画面にもはみ出さない
  const fit = await popover.evaluate((el) => {
    const main = document.querySelector("main")!;
    const r = el.getBoundingClientRect();
    return { mainOverflow: main.scrollWidth - main.clientWidth, left: r.left >= main.getBoundingClientRect().left, right: r.right <= main.getBoundingClientRect().right };
  });
  expect(fit).toEqual({ mainOverflow: 0, left: true, right: true });
  await popover.getByRole("button", { name: "パスをコピー" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(api.repo);
  await expect(popover).toHaveCount(0);
  await props.getByRole("button", { name: "Orca で開く" }).click();
  await page.getByRole("dialog", { name: "Orca で開けませんでした" }).getByRole("button", { name: "cd コマンドをコピー" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`cd '${api.repo}'`);
  // コピーの結果は行の下（次の行の上）に重ねて出す。クリックは下の行へ通し、数秒で消す
  const notice = props.getByRole("status");
  await expect(notice).toHaveText("コピーしました");
  const hit = await notice.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(hit).toBe(false);
  await expect(notice).toHaveCount(0, { timeout: 5000 });
  await props.getByRole("button", { name: "Reminder を編集" }).click();
  await expect(props.getByLabel("リマインダーの日付")).toBeVisible();
});

test("ブランチだけが記録された Issue は、実行場所の行にブランチ名だけを出し、「Orca で開く」を出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("ブランチだけ");
  // 着手の操作は worktree を必ず記録するため、ブランチだけの Issue（古いデータ）は API の応答を書き換えて作る
  await page.route(new RegExp(`/api/issues/${issue.id}(?:\\?|$)`), async (route) => {
    const json = await (await route.fetch()).json();
    for (const target of [json, json.issue]) if (target && "worktree" in target) Object.assign(target, { branch: "feat-branch-only", worktree: null });
    await route.fulfill({ json });
  });
  await page.goto(`/issues/${issue.id}`);
  const row = region(page, "プロパティ").locator("dl > div").filter({ has: page.locator("dt", { hasText: "実行場所" }) });
  await expect(row.locator("dd")).toHaveText("feat-branch-only");
  await expect(row.locator('[title="feat-branch-only"]')).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Orca で開く" })).toHaveCount(0);
  // ブランチだけでも実行場所は記録済みの扱いで、「Orca で作業を始める」も出さない（#210）
  await expect(row.getByRole("button", { name: "Orca で作業を始める" })).toHaveCount(0);
  expect((await row.boundingBox())?.height).toBe(28);
});

test("実行場所が記録されていない Issue には「Orca で開く」を出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "未着手" });
  await page.goto(`/issues/${created.id}`);
  await expect(region(page, "プロパティ").getByText("実行場所")).toBeVisible();
  await expect(page.getByRole("button", { name: "Orca で開く" })).toHaveCount(0);
});
