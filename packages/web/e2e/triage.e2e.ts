import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const list = (page: Page) => page.getByRole("region", { name: "Triage の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const empty = (page: Page) => list(page).getByText("Triage の Issue はありません");

test("LLM が起票した Issue だけを並べ、起票者と説明と4つの判断を出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.triageIssue("検索結果のページングが 1 件ずれる", "page=2 のとき 22 件目から返る");
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "私が起票した Issue" });

  await page.goto("/triage");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索結果のページングが 1 件ずれる" })).toBeVisible();
  await expect(detail(page).getByText(/claude-code が起票/)).toBeVisible();
  await expect(detail(page).getByText("page=2 のとき 22 件目から返る")).toBeVisible();
  for (const name of ["受け入れる", "重複にする", "後回し", "却下"]) {
    await expect(detail(page).getByRole("button", { name, exact: true })).toBeEnabled();
  }
});

test("受け入れると Todo になり、一覧から消える", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("検索結果のページングが 1 件ずれる");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "受け入れる" }).click();
  await expect(empty(page)).toBeVisible();
  expect((await api.show(i.id)).status).toBe("todo");
});

test("却下は理由を付けて Canceled にできる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("レート制限の残り回数をヘッダーで返す");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "却下", exact: true }).click();
  await detail(page).getByRole("textbox", { name: "却下の理由（任意）" }).fill("今は要らない");
  await detail(page).getByRole("button", { name: "却下する" }).click();
  await expect(empty(page)).toBeVisible();
  expect(await api.show(i.id)).toMatchObject({ status: "canceled", closeReason: "今は要らない" });
});

test("重複にすると元の Issue との関係を残して Canceled にする", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const original = await api.startedIssue("検索 API の N+1 を解消");
  const dup = await api.triageIssue("検索が遅い");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "重複にする" }).click();
  await detail(page).getByRole("textbox", { name: "元の Issue の ID" }).fill(original.id);
  await detail(page).getByRole("button", { name: "重複として閉じる" }).click();
  await expect(empty(page)).toBeVisible();
  const shown = await api.show(dup.id);
  expect(shown.status).toBe("canceled");
  expect(shown.relations.duplicateOf).toEqual([original.id]);
});

test("後回しにすると期限まで一覧に出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("ログのタイムゾーンを UTC に統一");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "後回し", exact: true }).click();
  await expect(detail(page).getByLabel("後回しの期限")).not.toHaveValue("");
  await detail(page).getByRole("button", { name: "後回しにする" }).click();
  await expect(empty(page)).toBeVisible();
  const shown = await api.show(i.id);
  expect(shown.status).toBe("triage");
  expect(Date.parse(shown.snoozedUntil ?? "")).toBeGreaterThan(Date.now());
});

test("Snooze の期限の前は出さず、期限を過ぎた Issue は再び出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const future = await api.triageIssue("期限の前の Issue");
  const past = await api.triageIssue("期限を過ぎた Issue");
  await nod.me.snoozeTriage(future.id, "2999-01-01");
  await nod.me.snoozeTriage(past.id, "2000-01-01");
  await page.goto("/triage");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(list(page).getByRole("link")).toContainText("期限を過ぎた Issue");
});

test("後回しの期限を手入力しても今日や過去の日付では送信できない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("ログのタイムゾーンを UTC に統一");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "後回し", exact: true }).click();
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeEnabled();
  await detail(page).getByLabel("後回しの期限").fill("2000-01-01");
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeDisabled();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await detail(page).getByLabel("後回しの期限").fill(today);
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeDisabled();
  expect((await api.show(i.id)).snoozedUntil).toBeNull();
  await detail(page).getByLabel("後回しの期限").fill("2999-01-01");
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeEnabled();
});

test("やめるで入力欄を閉じる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.triageIssue("検索結果のページングが 1 件ずれる");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "重複にする" }).click();
  await detail(page).getByRole("button", { name: "やめる" }).click();
  await expect(detail(page).getByRole("textbox", { name: "元の Issue の ID" })).toHaveCount(0);
});

test.describe("存在しない Issue を重複の元にする", () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("server のメッセージを出し、Issue は Triage に残る", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const i = await api.triageIssue("検索が遅い");
    await page.goto("/triage");
    await detail(page).getByRole("button", { name: "重複にする" }).click();
    await detail(page).getByRole("textbox", { name: "元の Issue の ID" }).fill("NOPE-1");
    await detail(page).getByRole("button", { name: "重複として閉じる" }).click();
    await expect(detail(page).getByRole("alert")).toContainText("NOPE-1");
    await expect(list(page).getByRole("link")).toHaveCount(1);
    expect((await api.show(i.id)).status).toBe("triage");
  });
});

test("似た Issue を一致率・共通語・状態つきで出し、比較で Issue 詳細を開ける", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const original = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索結果のページングが 1 件ずれる" });
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "ログのタイムゾーンを UTC に統一" });
  await api.triageIssue("検索結果のページングがずれる");
  await page.goto("/triage");
  const hints = detail(page).getByRole("list", { name: "似た Issue" });
  await expect(hints.getByRole("listitem")).toHaveCount(1);
  const row = hints.getByRole("listitem").first();
  await expect(row).toContainText(`似た Issue:${original.id}「検索結果のページングが 1 件ずれる」Todo`);
  await expect(row).toContainText(/一致 \d+% · 共通語: 検索結果のページングが/);
  await row.getByRole("link", { name: `${original.id} と比較` }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${original.id}$`));
});

test("重複にするは元の Issue の ID を入れた入力欄を開くだけで、確定すると重複として閉じる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const original = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索結果のページングが 1 件ずれる" });
  const dup = await api.triageIssue("検索結果のページングがずれる");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: `${original.id} の重複にする` }).click();
  await expect(detail(page).getByRole("textbox", { name: "元の Issue の ID" })).toHaveValue(original.id);
  expect((await api.show(dup.id)).status).toBe("triage");
  await detail(page).getByRole("button", { name: "重複として閉じる" }).click();
  await expect(empty(page)).toBeVisible();
  expect((await api.show(dup.id)).relations.duplicateOf).toEqual([original.id]);
});

test("ラベル・担当の候補を根拠つきで出し、クリックでフォームに入れて受け入れると確定する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const similar = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索結果のページングが 1 件ずれる", labels: ["search"] });
  await nod.me.updateIssue(similar.id, { assignee: "codex" });
  const i = await api.triageIssue("検索結果のページングがずれる bug");
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "無関係", labels: ["bug"] });
  await page.goto("/triage");
  const candidates = detail(page).getByRole("group", { name: "候補" });
  await expect(candidates).toContainText(`類似Issue 1件に付与（${similar.id}）`);
  await expect(candidates).toContainText("タイトルに“bug”を含む");
  await expect(candidates).toContainText(`類似Issue 1件の担当（${similar.id}）`);
  await candidates.getByRole("button", { name: "ラベル search を追加" }).click();
  await candidates.getByRole("button", { name: "ラベル bug を追加" }).click();
  await candidates.getByRole("button", { name: "担当を codex にする" }).click();
  await expect(detail(page).getByRole("textbox", { name: "受け入れ時のLabels" })).toHaveValue("search, bug");
  await expect(detail(page).getByRole("combobox", { name: "受け入れ時のAssignee" })).toHaveValue("codex");
  await expect(candidates).toHaveCount(0);
  expect(await api.show(i.id)).toMatchObject({ status: "triage", labels: [], assignee: null });
  await detail(page).getByRole("button", { name: "受け入れる" }).click();
  await expect(empty(page)).toBeVisible();
  expect(await api.show(i.id)).toMatchObject({ status: "todo", labels: ["bug", "search"], assignee: "codex" });
});

test("似た Issue も候補もなければ出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "ログのタイムゾーンを UTC に統一" });
  await api.triageIssue("検索結果のページングがずれる");
  await page.goto("/triage");
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索結果のページングがずれる" })).toBeVisible();
  await expect(detail(page).getByRole("button", { name: "受け入れる" })).toBeEnabled();
  await expect(detail(page).getByRole("list", { name: "似た Issue" })).toHaveCount(0);
  await expect(detail(page).getByRole("group", { name: "候補" })).toHaveCount(0);
});

// LLM の提案（#62）。提案は記録だけで、フォームに反映しても確定は人が既存のボタンで行う
test("LLM の提案を新しい順に出し、受け入れの提案をフォームに反映して人が受け入れると確定する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const project = await nod.me.createProject({ name: "検索 API の高速化" });
  const original = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "OpenAPI の説明文を整理" });
  const i = await api.triageIssue("検索結果のページングがずれる");
  await nod.codex.proposeTriage(i.id, { decision: "duplicate", duplicateOf: original.id, reason: "同じ原因の可能性" });
  await nod.claude.proposeTriage(i.id, {
    decision: "accept", labels: ["bug"], assignee: "codex", priority: 3, projectRef: String(project.id), reason: "再現を確認済み",
  });
  await page.goto("/triage");
  const proposals = detail(page).getByRole("region", { name: "LLM の提案" });
  await expect(proposals.getByRole("article")).toHaveCount(2);
  await expect(proposals.getByRole("article").first()).toHaveAccessibleName("claude-code の提案");
  const accept = proposals.getByRole("article", { name: "claude-code の提案" });
  await expect(accept).toContainText("受け入れ");
  await expect(accept).toContainText("検索 API の高速化");
  await expect(accept).toContainText("Medium");
  await expect(accept).toContainText("再現を確認済み");
  await expect(proposals.getByRole("article", { name: "codex の提案" })).toContainText(`重複 ${original.id}`);
  expect(await api.show(i.id)).toMatchObject({ status: "triage", labels: [], assignee: null });

  await accept.getByRole("button", { name: "claude-code の提案をフォームに反映" }).click();
  await expect(detail(page).getByRole("combobox", { name: "受け入れ時のProject" })).toHaveValue(String(project.id));
  await expect(detail(page).getByRole("combobox", { name: "受け入れ時のPriority" })).toHaveValue("3");
  await expect(detail(page).getByRole("textbox", { name: "受け入れ時のLabels" })).toHaveValue("bug");
  await expect(detail(page).getByRole("combobox", { name: "受け入れ時のAssignee" })).toHaveValue("codex");
  expect(await api.show(i.id)).toMatchObject({ status: "triage", labels: [], assignee: null });
  await detail(page).getByRole("button", { name: "受け入れる" }).click();
  await expect(empty(page)).toBeVisible();
  expect(await api.show(i.id)).toMatchObject({ status: "todo", labels: ["bug"], assignee: "codex", priority: 3 });
});

test("重複・却下の提案を反映すると既存の入力欄が開き、確定するまで Triage のまま", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const original = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "元の Issue" });
  const i = await api.triageIssue("重複かもしれない Issue");
  await nod.codex.proposeTriage(i.id, { decision: "duplicate", duplicateOf: original.id });
  await nod.claude.proposeTriage(i.id, { decision: "decline", reason: "対応済み" });
  await page.goto("/triage");
  const proposals = detail(page).getByRole("region", { name: "LLM の提案" });
  await proposals.getByRole("button", { name: "codex の提案をフォームに反映" }).click();
  await expect(detail(page).getByRole("textbox", { name: "元の Issue の ID" })).toHaveValue(original.id);
  await proposals.getByRole("button", { name: "claude-code の提案をフォームに反映" }).click();
  await expect(detail(page).getByRole("textbox", { name: "却下の理由（任意）" })).toHaveValue("対応済み");
  expect((await api.show(i.id)).status).toBe("triage");
  await detail(page).getByRole("button", { name: "却下する" }).click();
  await expect(empty(page)).toBeVisible();
  expect(await api.show(i.id)).toMatchObject({ status: "canceled", closeReason: "対応済み" });
});

test("me の提案を含むと見出しは「提案」になり、書き手ごとのカードで区別する。反映したラベルは分割されない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("見出しを確かめる Issue");
  await nod.claude.proposeTriage(i.id, { decision: "accept", labels: ["good-first-issue", "検索改善"] });
  await nod.me.proposeTriage(i.id, { decision: "decline", reason: "自分のメモ" });
  await page.goto("/triage");
  await expect(detail(page).getByRole("region", { name: "LLM の提案" })).toHaveCount(0);
  const proposals = detail(page).getByRole("region", { name: "提案", exact: true });
  await expect(proposals.getByRole("article")).toHaveCount(2);
  await expect(proposals.getByRole("article", { name: "me の提案" })).toContainText("却下");
  await proposals.getByRole("button", { name: "claude-code の提案をフォームに反映" }).click();
  await expect(detail(page).getByRole("textbox", { name: "受け入れ時のLabels" })).toHaveValue("good-first-issue, 検索改善");
  expect((await api.show(i.id)).status).toBe("triage");
});

test("提案がなければ LLM の提案ブロックを出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.triageIssue("提案のない Issue");
  await page.goto("/triage");
  await expect(detail(page).getByRole("button", { name: "受け入れる" })).toBeEnabled();
  await expect(detail(page).getByRole("region", { name: "LLM の提案" })).toHaveCount(0);
});

// #125: 一覧の各 Issue に LLM の提案の数をバッジで出す。提案が無ければ出さず、取り下げると減る
test("Triage 一覧に LLM の提案の数をバッジで出し、取り下げると減る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.triageIssue("2人が提案した Issue");
  await api.triageIssue("提案のない Issue");
  await nod.claude.proposeTriage(a.id, { decision: "accept" });
  await nod.codex.proposeTriage(a.id, { decision: "decline" });
  await page.goto("/triage");
  const item = (title: string) => list(page).getByRole("link").filter({ hasText: title });
  await expect(item("2人が提案した Issue")).toContainText("LLM提案 2");
  await expect(item("提案のない Issue")).toBeVisible();
  await expect(item("提案のない Issue")).not.toContainText("LLM提案");
  await nod.codex.withdrawTriageProposal(a.id);
  await page.reload();
  await expect(item("2人が提案した Issue")).toContainText("LLM提案 1");
  await nod.claude.withdrawTriageProposal(a.id);
  await page.reload();
  await expect(item("2人が提案した Issue")).toBeVisible();
  await expect(item("2人が提案した Issue")).not.toContainText("LLM提案");
});

// #117: 提案カードと候補のラベルも Dot を定義色にする
test("LLM の提案のラベルは定義色の Dot で出し、未定義のラベルは灰色", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await nod.me.addWorkspaceLabel("API", { name: "bug", color: "#B91C1C", description: "" });
  const i = await api.triageIssue("ラベルの色を確かめる Issue");
  await nod.claude.proposeTriage(i.id, { decision: "accept", labels: ["bug", "perf"] });
  await page.goto("/triage");
  const card = detail(page).getByRole("article", { name: "claude-code の提案" });
  await expect(card.locator('[data-label="bug"] > [data-label-color]')).toHaveCSS("background-color", "rgb(185, 28, 28)");
  await expect(card.locator('[data-label="perf"] > [data-label-color]')).toHaveAttribute("data-label-color", "default");
});
