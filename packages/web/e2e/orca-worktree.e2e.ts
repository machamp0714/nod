import { createHash } from "node:crypto";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { orcaCalls, stubOrca } from "./support/nod";

// Orca で作業を始める（#210）。e2e の server は実際の orca の代わりに stubOrca の結果を返す（Orca には触れず、worktree も作らない）
const hashOf = (id: string) => createHash("sha256").update(id.toUpperCase()).digest("hex").slice(0, 8);
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
  // 入力欄の説明は名前のプレビュー。トリガーはポップオーバーを aria-controls で指す
  await expect(feature).toHaveAccessibleDescription(`作成される名前 orca-worktree-${hashOf(created.id)}`);
  expect(await start.getAttribute("aria-controls")).toBe(await popover.getAttribute("id"));
  // エージェントは Claude Code と Codex の2択。初期値は Workspace の既定（最初は Claude Code）で、説明文は選んだエージェントに合わせる
  const agents = popover.getByRole("radiogroup", { name: "エージェント" });
  await expect(agents.getByRole("radio")).toHaveCount(2);
  await expect(agents.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(popover.getByText("worktree を作り、Claude Code のセッションを起動します。")).toBeVisible();
  await feature.fill("");
  await expect(submit).toBeDisabled();
  // 空欄の間は名前のプレビューを出さない
  await expect(popover.getByText("作成される名前")).toHaveCount(0);
  await expect(popover.getByText(hashOf(created.id))).toHaveCount(0);
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

  // 失敗のあとでエージェントを選び直せる
  await agents.getByRole("radio", { name: "Codex" }).check();
  await expect(popover.getByText("worktree を作り、Codex のセッションを起動します。")).toBeVisible();

  // 作成中は入力とボタンを無効にし、ラベルを「作成中…」にする
  await stubOrca({ "worktree create": ok({ worktree: { path: worktree, branch: "refs/heads/machamp0714/API-1-search-n1" }, agentTerminalHandle: "term_new" }) });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/issues/*/orca-worktree", async (route) => { await held; await route.continue(); });
  await submit.click();
  const creating = popover.getByRole("button", { name: "作成中…" });
  await expect(creating).toBeDisabled();
  await expect(feature).toBeDisabled();
  await expect(agents.getByRole("radio", { name: "Claude Code" })).toBeDisabled();
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
    ["worktree", "create", "--repo", `path:${api.repo}`, "--name", `search-n1-${hashOf(created.id)}`, "--no-parent", "--agent", "codex", "--activate", "--json"],
  ]);
  const issue = await api.show(created.id);
  expect({ worktree: issue.worktree, branch: issue.branch, status: issue.status, assignee: issue.assignee }).toEqual({
    worktree, branch: "machamp0714/API-1-search-n1", status: created.status, assignee: created.assignee,
  });
});

test("Workspace の設定で既定のエージェントを Codex にすると、「Orca で作業を始める」の初期値が Codex になる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "search n1" });
  await stubOrca({ "worktree create": ok({ worktree: { path: `${nod.dir}/orca/x`, branch: "refs/heads/x" } }) });
  await page.goto(`/workspaces/${api.workspace.key}/settings`);
  const section = region(page, "Orca で起動するエージェント");
  const defaults = section.getByRole("radiogroup", { name: "既定のエージェント" });
  await expect(defaults.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await defaults.getByRole("radio", { name: "Codex" }).check();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await page.reload();
  await expect(defaults.getByRole("radio", { name: "Codex" })).toBeChecked();

  await page.goto(`/issues/${created.id}`);
  await region(page, "プロパティ").getByRole("button", { name: "Orca で作業を始める" }).click();
  const popover = page.getByRole("dialog", { name: "Orca で作業を始める" });
  await expect(popover.getByRole("radio", { name: "Codex" })).toBeChecked();
  await expect(popover.getByText("worktree を作り、Codex のセッションを起動します。")).toBeVisible();
  // 作成時に選び直せる。選び直しても Workspace の既定は変わらない
  await popover.getByRole("radio", { name: "Claude Code" }).check();
  await popover.getByRole("button", { name: "作成して起動" }).click();
  await expect(popover).toHaveCount(0);
  expect((await orcaCalls())[0]?.slice(7, 9)).toEqual(["--agent", "claude"]);
  expect((await nod.me.listWorkspaces())[0]?.defaultAgent).toBe("codex");
});
