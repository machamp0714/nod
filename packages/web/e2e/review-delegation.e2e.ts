import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { orcaCalls, stubOrca } from "./support/nod";

// 差し戻しの「LLM に対応を依頼」（#58）。e2e の server は実際の orca の代わりに stubOrca の結果を返す
const ok = (result: unknown) => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const sends = async () => (await orcaCalls()).filter((c) => c[1] === "send");

test("指摘対応を依頼して差し戻すと、送信確認を出し、送信で稼働中の端末へ届ける", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await stubOrca({
    "terminal list": ok({ terminals: [{ handle: "term_a", title: "claude", worktreePath: api.repo, connected: true, writable: true, agentIdentity: "claude" }] }),
    "terminal send": ok({ accepted: true }),
  });
  await page.goto("/reviews");
  const radios = detail(page).getByRole("radiogroup", { name: "依頼する対応" });
  await expect(radios.getByRole("radio", { name: "指摘対応" })).toBeDisabled();
  await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).fill("署名ヘッダが無いリクエストのテストが無い");
  await detail(page).getByRole("checkbox", { name: "LLM に対応を依頼" }).check();
  await expect(radios.getByRole("radio", { name: "指摘対応" })).toBeChecked();
  await detail(page).getByRole("button", { name: "差し戻す" }).click();

  const dialog = page.getByRole("dialog", { name: "claude-code に対応依頼を送信しますか？" });
  await expect(dialog.getByText("理由: 署名ヘッダが無いリクエストのテストが無い")).toBeVisible();
  expect(await sends()).toEqual([]);
  await dialog.getByRole("button", { name: "送信", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const sent = await sends();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.[5]).toContain(`nod: ${i.id} が差し戻されました。対応依頼（指摘対応）: 署名ヘッダが無いリクエストのテストが無い`);
  const shown = await api.show(i.id);
  expect(shown.status).toBe("in_progress");
  expect(shown.pendingInstructions).toMatchObject([{ kind: "review_fix", sendState: "sent" }]);
});

test("rebase を依頼して、送信先が無ければ記録だけ残す。依頼しなければ確認を出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("検索", "直した");
  const j = await api.inReview("一覧", "直した");
  await stubOrca({ "terminal list": ok({ terminals: [] }) });
  await page.goto(`/reviews?selected=${i.id}`);
  await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).fill("main が進んだので追従して");
  await detail(page).getByRole("checkbox", { name: "LLM に対応を依頼" }).check();
  await detail(page).getByRole("radio", { name: "rebase" }).check();
  await detail(page).getByRole("button", { name: "差し戻す" }).click();
  const dialog = page.getByRole("dialog", { name: "送信先の端末がありません" });
  await expect(dialog.getByText(/LLM は次の start\/show で読みます/)).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる" }).click();
  expect((await api.show(i.id)).pendingInstructions).toMatchObject([{ kind: "rebase", sendState: "unsent" }]);

  await page.goto(`/reviews?selected=${j.id}`);
  await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).fill("理由だけ");
  await detail(page).getByRole("button", { name: "差し戻す" }).click();
  await expect(page.getByRole("region", { name: "レビュー待ちの一覧" }).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await api.show(j.id)).pendingInstructions).toEqual([]);
  expect((await orcaCalls()).filter((c) => c[1] === "list")).toHaveLength(1);
});
