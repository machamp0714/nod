import { createHash } from "node:crypto";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { orcaCalls, stubOrca } from "./support/nod";

// Omp で作業を始める（#210、NOD-61）。e2e の server は実際の orca の代わりに stubOrca の結果を返す（Orca には触れず、worktree も作らない）
const hashOf = (id: string) => createHash("sha256").update(id.toUpperCase()).digest("hex").slice(0, 8);
const ok = (result: unknown) => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });

test("表示名と下書き入力が失敗しても作成済みの場所を保持し、両方の警告と復旧コマンドを表示する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "通知の表示を直す" });
  const worktree = `${nod.dir}/orca/recovery`;
  await stubOrca({
    "worktree create": ok({ worktree: { path: worktree, branch: "machamp0714/recovery" }, agentTerminalHandle: "term_new" }),
    "worktree set": { kind: "timeout" },
    "terminal wait": { kind: "timeout" },
  });
  await page.goto(`/issues/${created.id}`);
  await region(page, "プロパティ").getByRole("button", { name: "Omp で作業を始める" }).click();
  const popover = page.getByRole("dialog", { name: "Omp で作業を始める" });
  await popover.getByRole("button", { name: "作成して起動" }).click();
  await expect(popover).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Orca で開く" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "表示名を設定できませんでした" })).toContainText("作成しました");
  await expect(page.getByRole("alert").filter({ hasText: "IDの入力を確認できませんでした" })).toBeVisible();
  await expect(page.getByText(`orca worktree set --worktree 'path:${worktree}' --display-name '${created.id} 通知の表示を直す' --json`, { exact: true })).toBeVisible();
  expect((await api.show(created.id)).worktree).toBe(worktree);
  expect((await orcaCalls()).map((args) => args.slice(0, 2).join(" "))).toEqual(["worktree create", "worktree set", "terminal wait"]);
});

test("実行場所が未記録の Issue で「Omp で作業を始める」から worktree を作ると、実行場所が記録されて「Orca で開く」に変わる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "Orca で worktree を作成" });
  const worktree = `${nod.dir}/orca/${created.id}-search-n1`;
  await stubOrca({}); // orca が無い
  await page.goto(`/issues/${created.id}`);
  const props = region(page, "プロパティ");
  const row = props.locator("dl > div").filter({ has: page.locator("dt", { hasText: "実行場所" }) });
  await expect(row.getByRole("button", { name: "Orca で開く" })).toHaveCount(0);
  const start = row.getByRole("button", { name: "Omp で作業を始める" });
  await start.click();
  expect((await row.boundingBox())?.height).toBe(28);

  // feature 名の初期値はタイトルの英数字の語。英小文字・数字・- 以外は入らず、空欄でも作成できる
  const popover = page.getByRole("dialog", { name: "Omp で作業を始める" });
  const feature = popover.getByLabel("feature 名（任意）");
  const submit = popover.getByRole("button", { name: "作成して起動" });
  await expect(feature).toHaveValue("orca-worktree");
  await expect(feature).toBeFocused();
  // 入力欄の説明は名前のプレビュー。トリガーはポップオーバーを aria-controls で指す
  await expect(feature).toHaveAccessibleDescription(`Orca の表示名 ${created.id} Orca で worktree を作成 ディレクトリ・ブランチの作成名 orca-worktree-${hashOf(created.id)}`);
  expect(await start.getAttribute("aria-controls")).toBe(await popover.getAttribute("id"));
  // エージェントは選ばせない（常に Omp を起動する）。説明文で起動後の状態を示す
  await expect(popover.getByRole("radiogroup")).toHaveCount(0);
  await expect(popover.getByRole("radio")).toHaveCount(0);
  await expect(popover.getByText("worktree を作り、Orca で Omp のセッションを起動します。IDを入力欄に入れ、送信はしません。", { exact: true })).toBeVisible();
  await feature.fill("");
  await expect(submit).toBeEnabled();
  // 空欄でも表示名と省略形の作成名を確認できる
  await expect(popover.getByText(`${created.id} Orca で worktree を作成`, { exact: true })).toBeVisible();
  await expect(popover.getByText(hashOf(created.id), { exact: true })).toBeVisible();
  await feature.fill("Search N+1_検索");
  await expect(feature).toHaveValue("searchn1");
  await feature.fill("search-n1");
  await expect(popover.getByText(`search-n1-${hashOf(created.id)}`)).toBeVisible();
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
  await stubOrca({ "worktree create": ok({ worktree: { path: worktree, branch: "refs/heads/machamp0714/API-1-search-n1" }, agentTerminalHandle: "term_new" }), "worktree set": ok({}), "terminal wait": ok({ wait: { satisfied: true } }), "terminal send": ok({ send: { accepted: true } }) });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/issues/*/orca-worktree", async (route) => { await held; await route.continue(); });
  await submit.click();
  const creating = popover.getByRole("button", { name: "作成中…" });
  await expect(creating).toBeDisabled();
  await expect(feature).toBeDisabled();
  await expect(popover.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  await expect(popover.getByRole("alert")).toHaveCount(0);
  // 作成中はトリガーを押しても閉じない（結果と入力を失わない）
  await start.click();
  await expect(popover).toBeVisible();
  await expect(feature).toHaveValue("search-n1");
  release();

  // 成功したら閉じ、行が「ブランチ · worktree」と「Orca で開く」に変わる。orca は決まった引数で1回だけ呼ばれる
  await expect(popover).toHaveCount(0);
  await expect(row.locator("dd")).toContainText(`machamp0714/API-1-search-n1 · ${worktree}`);
  await expect(row.getByRole("button", { name: "Orca で開く" })).toBeFocused();
  await expect(start).toHaveCount(0);
  expect(await orcaCalls()).toEqual([
    ["worktree", "create", "--repo", `path:${api.repo}`, "--name", `search-n1-${hashOf(created.id)}`, "--no-parent", "--agent", "omp", "--surface", "terminal", "--activate", "--json"],
    ["worktree", "set", "--worktree", `path:${worktree}`, "--display-name", `${created.id} Orca で worktree を作成`, "--json"],
    ["terminal", "wait", "--terminal", "term_new", "--for", "tui-idle", "--timeout-ms", "30000", "--json"],
    ["terminal", "send", "--terminal", "term_new", "--text", created.id, "--json"],
  ]);
  const issue = await api.show(created.id);
  expect({ worktree: issue.worktree, branch: issue.branch, status: issue.status, assignee: issue.assignee }).toEqual({
    worktree, branch: "machamp0714/API-1-search-n1", status: created.status, assignee: created.assignee,
  });
});

test("新しい Workspace は設定しないまま Omp で作業を始められ、Workspace の設定に「既定のエージェント」の節は無い", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "search n1" });
  await page.goto(`/workspaces/${api.workspace.key}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: `${api.workspace.name} の設定` })).toBeVisible();
  await expect(region(page, "LLM に守らせる作業規約")).toBeVisible();
  await expect(region(page, "Orca で起動するエージェント")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Orca で起動するエージェント" })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "既定のエージェント" })).toHaveCount(0);

  // 端末を特定できない結果でも worktree は記録し、下書き警告で ID の手入力を案内する
  await stubOrca({ "worktree create": ok({ worktree: { path: `${nod.dir}/orca/x`, branch: "refs/heads/x" } }), "worktree set": ok({}) });
  await page.goto(`/issues/${created.id}`);
  await region(page, "プロパティ").getByRole("button", { name: "Omp で作業を始める" }).click();
  const popover = page.getByRole("dialog", { name: "Omp で作業を始める" });
  await expect(popover.getByRole("radio")).toHaveCount(0);
  await popover.getByRole("button", { name: "作成して起動" }).click();
  await expect(popover).toHaveCount(0);
  expect((await orcaCalls())[0]).toEqual([
    "worktree", "create", "--repo", `path:${api.repo}`, "--name", `search-n1-${hashOf(created.id)}`, "--no-parent", "--agent", "omp", "--surface", "terminal", "--activate", "--json",
  ]);
  await expect(page.getByRole("alert")).toContainText(`必要なら ${created.id} を入力してください`);
  await expect(page.getByRole("button", { name: "Orca で開く" })).toBeVisible();
});

test("日本語だけのタイトルも feature 名なしで作成でき、同名・別名の作業を表示名で見分けられる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  for (const title of ["検索を速くする", "検索を速くする", "通知の表示を直す"]) {
    const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title });
    const worktree = `${nod.dir}/orca/${hashOf(created.id)}`;
    await stubOrca({ "worktree create": ok({ worktree: { path: worktree, branch: `machamp0714/${hashOf(created.id)}` }, agentTerminalHandle: "term_new" }), "worktree set": ok({}), "terminal wait": ok({ wait: { satisfied: true } }), "terminal send": ok({ send: { accepted: true } }) });
    await page.goto(`/issues/${created.id}`);
    await region(page, "プロパティ").getByRole("button", { name: "Omp で作業を始める" }).click();
    const popover = page.getByRole("dialog", { name: "Omp で作業を始める" });
    await expect(popover.getByLabel("feature 名（任意）")).toHaveValue("");
    await expect(popover.getByText(`${created.id} ${title}`, { exact: true })).toBeVisible();
    await expect(popover.getByText(hashOf(created.id), { exact: true })).toBeVisible();
    await popover.getByRole("button", { name: "作成して起動" }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Orca で開く" })).toBeVisible();
    expect((await orcaCalls()).filter((args) => args[1] === "set").at(-1)).toEqual([
      "worktree", "set", "--worktree", `path:${worktree}`, "--display-name", `${created.id} ${title}`, "--json",
    ]);
    expect((await api.show(created.id)).worktree).toBe(worktree);
  }
});
