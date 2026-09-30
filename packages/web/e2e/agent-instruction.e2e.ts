import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { orcaCalls, stubOrca } from "./support/nod";

// LLM に追加指示（#51）。e2e の server は実際の orca の代わりに stubOrca の結果を返す（Orca には触れない）
const ok = (result: unknown) => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });
const term = (worktree: string, handle: string, agentIdentity: string | null = "claude", title = "claude") =>
  ({ handle, title, worktreePath: worktree, connected: true, writable: true, agentIdentity });
const BODY = "インデックスは (workspace_id, created_at) の複合にしてください";

async function openInstruction(page: Page, id: string) {
  await page.goto(`/issues/${id}`);
  const activity = region(page, "Activity");
  await activity.getByRole("radio", { name: "LLM に追加指示" }).click();
  await activity.getByRole("textbox", { name: "追加指示" }).fill(BODY);
  await activity.getByRole("button", { name: "送信…" }).click();
  return activity;
}

const sends = async () => (await orcaCalls()).filter((c) => c[1] === "send");

test("宛先が1件なら宛先・端末・handle・worktree と本文を確認してから送信し、送信済みを出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索 API の N+1 を解消");
  await stubOrca({ "terminal list": ok({ terminals: [term(api.repo, "term_a"), term(api.repo, "term_sh", null, "zsh")] }), "terminal send": ok({ accepted: true }) });
  const activity = await openInstruction(page, issue.id);
  await expect(activity.getByText("宛先: claude-code（Orca · main）")).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "claude-code に追加指示を送信しますか？" });
  await expect(dialog.getByText("term_a", { exact: true })).toBeVisible();
  await expect(dialog.getByText(api.repo)).toBeVisible();
  await expect(dialog.getByText(BODY)).toBeVisible();
  expect(await sends()).toEqual([]); // 確認画面を開いただけでは送らない

  await dialog.getByRole("button", { name: "送信", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const card = activity.getByRole("article", { name: "追加指示" });
  await expect(card.getByText("追加指示", { exact: true })).toBeVisible();
  await expect(card.getByText(/送信済み .* → claude/)).toBeVisible();
  await expect(card.getByRole("button", { name: "送信…" })).toHaveCount(0);
  const sent = await sends();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.slice(0, 4)).toEqual(["terminal", "send", "--terminal", "term_a"]);
  expect(sent[0]?.[5]).toContain(`nod: ${issue.id} に追加指示があります`);
});

test("記録のみは送らず、未送信として残す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索");
  await stubOrca({ "terminal list": ok({ terminals: [term(api.repo, "term_a")] }), "terminal send": ok({ accepted: true }) });
  const activity = await openInstruction(page, issue.id);
  await page.getByRole("dialog").getByRole("button", { name: "記録のみ" }).click();
  await expect(activity.getByRole("article", { name: "追加指示" }).getByText("未送信（LLM は start/show で読みます）")).toBeVisible();
  expect(await sends()).toEqual([]);
});

test("端末が無ければ記録のみを示し、キャンセルでは何も残さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索");
  await stubOrca({ "terminal list": ok({ terminals: [term(api.repo, "term_sh", null, "zsh")] }) });
  const activity = await openInstruction(page, issue.id);
  const dialog = page.getByRole("dialog", { name: "追加指示を記録しますか？" });
  await expect(dialog.getByText("送信先の端末がありません。記録のみ行い、LLM は次の start/show で読みます")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "送信", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(activity.getByRole("article", { name: "追加指示" })).toHaveCount(0);
  await expect(activity.getByRole("textbox", { name: "追加指示" })).toHaveValue(BODY);
  await activity.getByRole("button", { name: "送信…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "記録のみ" }).click();
  await expect(activity.getByRole("article", { name: "追加指示" })).toHaveCount(1);
  expect((await api.show(issue.id)).pendingInstructions).toHaveLength(1);
});

test("宛先が複数なら選んだ端末に送る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索");
  await stubOrca({
    "terminal list": ok({ terminals: [term(api.repo, "term_a"), term(api.repo, "term_b", "codex", "codex")] }),
    "terminal send": ok({ accepted: true }),
  });
  await openInstruction(page, issue.id);
  const dialog = page.getByRole("dialog", { name: "送信先を選んでください" });
  await dialog.getByRole("radio", { name: /codex · codex/ }).check();
  await dialog.getByRole("button", { name: "送信", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await sends())[0]?.slice(2, 4)).toEqual(["--terminal", "term_b"]);
});

test("送信に失敗したら理由を出し、Activity の「送信…」から送り直せる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索");
  await stubOrca({ "terminal list": ok({ terminals: [term(api.repo, "term_a")] }) }); // terminal send は orca が無い扱い
  const activity = await openInstruction(page, issue.id);
  await page.getByRole("dialog").getByRole("button", { name: "送信", exact: true }).click();
  const card = activity.getByRole("article", { name: "追加指示" });
  await expect(card.getByText(/^送信失敗: orca が見つかりません/)).toBeVisible();

  await stubOrca({ "terminal list": ok({ terminals: [term(api.repo, "term_a")] }), "terminal send": ok({ accepted: true }) });
  await card.getByRole("button", { name: "送信…" }).click();
  const dialog = page.getByRole("dialog", { name: "claude-code に追加指示を送信しますか？" });
  await expect(dialog.getByRole("button", { name: "記録のみ" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "送信", exact: true }).click();
  await expect(card.getByText(/送信済み/)).toBeVisible();
  expect(await sends()).toHaveLength(1);
});

test("コメントのモードでは今までどおりコメントになる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("検索");
  await page.goto(`/issues/${issue.id}`);
  const activity = region(page, "Activity");
  await expect(activity.getByRole("radio", { name: "コメント" })).toHaveAttribute("aria-checked", "true");
  await activity.getByRole("textbox", { name: "コメント" }).fill("普通のコメント");
  await activity.getByRole("button", { name: "コメントする" }).click();
  await expect(activity.getByRole("article", { name: "コメント記録" }).getByText("普通のコメント")).toBeVisible();
  await expect(activity.getByRole("article", { name: "追加指示" })).toHaveCount(0);
  expect(await orcaCalls()).toEqual([]);
});
