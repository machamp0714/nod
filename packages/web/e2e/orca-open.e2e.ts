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
});

test("実行場所が記録されていない Issue には「Orca で開く」を出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "未着手" });
  await page.goto(`/issues/${created.id}`);
  await expect(region(page, "プロパティ").getByText("実行場所")).toBeVisible();
  await expect(page.getByRole("button", { name: "Orca で開く" })).toHaveCount(0);
});
