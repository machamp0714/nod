import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { measureSplitList } from "./layout-measure";

const list = (page: Page) => page.getByRole("region", { name: "レビュー待ちの一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });

test("完了報告、PR、計画と確認依頼の数を出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.startedIssue("決済 Webhook の署名検証を追加");
  await nod.claude.setPlanTasks(i.id, ["署名の検証", "テスト"]);
  await nod.claude.setStep(i.id, "1", "done");
  await nod.claude.setStep(i.id, "2", "done");
  await api.ask(i.id, "失敗したときは 401 と 400 のどちらを返しますか？");
  await nod.me.answerQuestion(i.id, "401");
  await nod.claude.commentIssue(i.id, "途中の経過");
  await nod.claude.completeIssue(i.id, {
    summary: "HMAC-SHA256 で署名を検証した",
    prUrl: "https://github.com/example/api-server/pull/128",
  });

  await page.goto("/reviews");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "決済 Webhook の署名検証を追加" })).toBeVisible();
  const report = detail(page).getByRole("region", { name: "完了報告" });
  await expect(report.getByText("claude-code の完了報告")).toBeVisible();
  await expect(report.getByText("HMAC-SHA256 で署名を検証した")).toBeVisible();
  await expect(report.getByText("途中の経過")).toHaveCount(0);
  await expect(detail(page).getByRole("link", { name: "GitHub で開く" })).toHaveAttribute("href", "https://github.com/example/api-server/pull/128");
  await expect(detail(page).getByText("計画 2/2 完了")).toBeVisible();
  await expect(detail(page).getByText("確認依頼 1 件（回答済み 1 件）")).toBeVisible();
});

test("承認すると Done になり、一覧から消える", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await page.goto("/reviews");
  await detail(page).getByRole("button", { name: "承認して閉じる" }).click();
  await expect(list(page).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  expect((await api.show(i.id)).status).toBe("done");
});

test("差し戻しは理由がないと押せず、理由を書くと In Progress に戻して理由をコメントに残す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await page.goto("/reviews");
  const reject = detail(page).getByRole("button", { name: "差し戻す" });
  await expect(reject).toBeDisabled();
  await detail(page).getByRole("textbox", { name: "差し戻しの理由" }).fill("改ざんされたケースのテストが足りない");
  await reject.click();

  await expect(list(page).getByText("レビュー待ちの Issue はありません")).toBeVisible();
  const shown = await api.show(i.id);
  expect(shown.status).toBe("in_progress");
  const comments = shown.activity.filter((a) => a.kind === "comment");
  expect(comments.at(-1)).toMatchObject({ actor: "me", body: "改ざんされたケースのテストが足りない" });
});

test("PR がない Issue は PR はありませんと出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.inReview("OpenAPI の説明文を更新する", "説明文を直した");
  await page.goto("/reviews");
  await expect(detail(page).getByText("PR はありません")).toBeVisible();
});

// #185：nod.pen の 14 Reviews（TCAVE）
// #177：説明（受け入れ条件を含む）を Reviews から開く（nod.pen『14 Reviews｜説明と Issue を開く』iQ93X、『14 Reviews｜説明（閉）』b5AWe）
test("説明は閉じた状態で出し、開くと Markdown で読める。Issue を選び直すと閉じた状態に戻る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const first = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await nod.me.updateIssue(first.id, { description: "署名なしの Webhook を弾く。\n\n## 受け入れ条件\n\n- 署名が不正なら 401 を返す\n- 5 分より古いリクエストは拒否する" });
  await api.inReview("説明のない Issue", "終えた");

  await page.goto(`/reviews?selected=${first.id}`);
  const section = detail(page).getByRole("region", { name: "説明" });
  const toggle = section.getByRole("button", { name: "説明" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByText("署名なしの Webhook を弾く。")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(section.getByText("署名なしの Webhook を弾く。")).toBeVisible();
  await expect(section.getByRole("heading", { name: "受け入れ条件" })).toBeVisible();
  await expect(section.getByRole("listitem")).toHaveText(["署名が不正なら 401 を返す", "5 分より古いリクエストは拒否する"]);
  // 完了報告の次、PR や差し戻し欄の前に置く
  const order = await detail(page).locator("> div > *").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.tagName));
  expect(order.indexOf("説明")).toBe(order.indexOf("完了報告") + 1);
  // 見出し行は chevron 14 と「説明」（13px・600）、本文は左に 20 下げる
  const m = await section.evaluate((el) => {
    const button = el.querySelector("button")!;
    const body = el.children[1] as HTMLElement;
    const title = getComputedStyle(button);
    return { icon: button.querySelector("svg")!.getBoundingClientRect().width, fontSize: title.fontSize, fontWeight: title.fontWeight, indent: body.getBoundingClientRect().left - el.getBoundingClientRect().left + parseFloat(getComputedStyle(body).paddingLeft) };
  });
  console.log(`[reviews] 説明 ${JSON.stringify(m)}`);
  expect(m).toEqual({ icon: 14, fontSize: "13px", fontWeight: "600", indent: 20 });
  await toggle.click();
  await expect(section.getByText("署名なしの Webhook を弾く。")).toHaveCount(0);

  await toggle.click();
  await list(page).getByRole("link", { name: /説明のない Issue/ }).click();
  await expect(detail(page).getByRole("heading", { level: 2, name: "説明のない Issue" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(section.getByText("説明はありません")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-controls", /.+/);
});

test("Issue を開くで Issue 詳細に移る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
  await page.goto("/reviews");
  const link = detail(page).getByRole("link", { name: "Issue を開く" });
  await expect(link).toHaveAttribute("href", `/issues/${i.id}`);
  // 承認・差し戻しのボタンより下に置く
  const linkTop = (await link.boundingBox())!.y;
  const buttonBottom = await detail(page).getByRole("button", { name: "差し戻す" }).evaluate((el) => el.getBoundingClientRect().bottom);
  expect(linkTop).toBeGreaterThan(buttonBottom);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${i.id}$`));
});

test("一覧の Header は高さ 44 で題名の右に説明文を置き（件数は置かない）、行は左右と上下に 8 の余白、角丸 8 で、区切り線がない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.inReview("決済 Webhook の署名検証を追加", "HMAC-SHA256 で署名を検証し、失敗時は 401 を返すようにしました。テストを 6 件追加しています。");
  await api.inReview("nod issue list に --json を追加", "全コマンドで --json を受け付けるようにした");
  await page.goto("/reviews");
  await expect(list(page).getByRole("link")).toHaveCount(2);
  await expect(detail(page).getByRole("region", { name: "完了報告" })).toBeVisible();
  const description = list(page).getByText("LLM が作業を終え、確認を待っている Issue");
  await expect(description).toBeVisible();
  await expect(description).toHaveAttribute("title", "LLM が作業を終え、確認を待っている Issue");
  await expect(description).toHaveCSS("font-size", "12px");
  // 幅 400 で説明文は省略されず、全文が出る
  expect(await description.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const m = await measureSplitList(page, "レビュー待ちの一覧");
  console.log(`[split] /reviews ${JSON.stringify(m)}`);
  expect(m.listWidth).toBe(400);
  expect(m.headerHeight).toBe(44);
  expect(m.headerOverflow).toBe(0);
  expect(m.title).toBe("13px / 500");
  // 題名と説明文だけが重ならずに並び、中心が揃う。右端に件数を置かない
  expect(m.headerTexts).toEqual(["Reviews", "LLM が作業を終え、確認を待っている Issue"]);
  expect(m.headerParts).toBe(2);
  expect(m.headerGap).toBeGreaterThanOrEqual(8);
  expect(m.headerCenterDiff).toBeLessThanOrEqual(2.5);
  expect(m.row).toEqual({ left: 8, right: 8, top: 8, bottom: 8, radius: "8px", padding: "12px", borderTop: "0px" });
  expect(m.selectedBackground).toBe("rgb(238, 240, 243)"); // --sunken
  expect(m.titleWeights).toEqual(["500"]);
});
