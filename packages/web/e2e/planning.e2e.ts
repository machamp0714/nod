import { expect, test } from "./fixtures";
import { chooseProperty, property, propertyMenu } from "./helpers";
import { chooseDisplay, displaySelect } from "./support/issue-list";

test.use({ dataset: "issue-list" });

// ブラウザと同じローカルの暦日（e2e のブラウザは Node と同じマシンで動く）
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("Initiative を作り、Project を紐付け・外し、状態と目標日を変え、Project 詳細に所属を出す", async ({ page, nod }) => {
  await page.goto("/issues");
  await page.getByRole("link", { name: "Initiatives" }).click();
  await expect(page).toHaveURL(/\/initiatives$/);
  await expect(page.getByText("Initiative はありません")).toBeVisible();

  await page.getByRole("button", { name: "New initiative" }).click();
  const dialog = page.getByRole("dialog", { name: "New initiative" });
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("名前を入力してください");
  await dialog.getByLabel("名前").fill("検索基盤の刷新");
  await dialog.getByLabel("説明").fill("検索の速度と精度を上げる");
  await dialog.getByLabel("目標日").fill("2026-12-20");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/initiatives\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: "検索基盤の刷新" })).toBeVisible();
  await expect(page.getByText("この Initiative に Project はありません。「Project を追加」から紐づけます")).toBeVisible();

  const add = page.getByRole("combobox", { name: "Project を追加" });
  await add.selectOption({ label: "検索 API の高速化" });
  await add.selectOption({ label: "決済まわり" });
  const projects = page.getByRole("region", { name: "配下の Project" });
  await expect(projects.getByRole("listitem")).toHaveCount(2);
  const [initiative] = await nod.me.listInitiatives({ includeClosed: true });
  const detail = await nod.me.getInitiative(String(initiative!.id));
  expect(detail.projects.map((p) => p.name)).toEqual(["検索 API の高速化", "決済まわり"]);
  await expect(page.getByText(`Issue ${detail.done}/${detail.total} 完了`)).toBeVisible();

  await page.getByRole("combobox", { name: "Status" }).selectOption({ label: "Active" });
  await expect.poll(async () => (await nod.me.getInitiative(String(initiative!.id))).status).toBe("started");
  const target = page.getByLabel("目標日");
  await target.fill("2027-01-31");
  await target.blur();
  await expect.poll(async () => (await nod.me.getInitiative(String(initiative!.id))).targetDate).toBe("2027-01-31");

  await projects.getByRole("button", { name: "決済まわり の紐付けを外す" }).click();
  await expect(projects.getByRole("listitem")).toHaveCount(1);

  await projects.getByRole("link", { name: "検索 API の高速化" }).click();
  const chip = page.getByRole("link", { name: /Initiative\s*検索基盤の刷新/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/initiatives/${initiative!.id}$`));

  await page.goto("/initiatives");
  const row = page.getByRole("row", { name: /検索基盤の刷新/ });
  await expect(row).toContainText("Active");
  await expect(row).toContainText("2027-01-31");
  await expect(row.getByRole("cell").last()).toHaveText("1");
});

test.describe("Initiative の編集（#154）", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("詳細の「編集」で名前と説明を直し、空・重複の名前は欄の下に理由を出して保存しない", async ({ page, nod }) => {
    await nod.me.createInitiative({ name: "決済の信頼性向上" });
    const target = await nod.me.createInitiative({ name: "検索基盤の刷新", description: "旧い説明" });
    await page.goto(`/initiatives/${target.id}`);
    await page.getByRole("button", { name: "編集" }).click();
    const dialog = page.getByRole("dialog", { name: "Initiative を編集" });
    await expect(dialog.getByLabel("名前")).toHaveValue("検索基盤の刷新");
    await expect(dialog.getByLabel("説明")).toHaveValue("旧い説明");

    await dialog.getByLabel("名前").fill(" ");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.getByText("名前を入力してください")).toBeVisible();
    await dialog.getByLabel("名前").fill("決済の信頼性向上");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.getByText("同じ名前の Initiative「決済の信頼性向上」があります")).toBeVisible();
    await expect(dialog.getByLabel("名前")).toHaveAttribute("aria-invalid", "true");
    expect((await nod.me.getInitiative(String(target.id))).name).toBe("検索基盤の刷新");

    await dialog.getByLabel("名前").fill("  検索基盤の刷新 v2 ");
    await dialog.getByLabel("説明").fill("検索の速度と精度を上げる\nUI もまとめて追う");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "検索基盤の刷新 v2" })).toBeVisible();
    const saved = await nod.me.getInitiative(String(target.id));
    expect([saved.name, saved.description]).toEqual(["検索基盤の刷新 v2", "検索の速度と精度を上げる\nUI もまとめて追う"]);

    // 説明を空にすると外れる。キャンセルでは何も変えない
    await page.getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("説明").fill("");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    expect((await nod.me.getInitiative(String(target.id))).description).toBeNull();
    await page.getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("名前").fill("捨てる");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    expect((await nod.me.getInitiative(String(target.id))).name).toBe("検索基盤の刷新 v2");
  });

  test("名前だけ直したとき、説明の字下げ・末尾の改行を消さない（#154）", async ({ page, nod }) => {
    const description = "  字下げした一行目\n- 箇条書き\n";
    const target = await nod.me.createInitiative({ name: "検索基盤の刷新", description });
    await page.goto(`/initiatives/${target.id}`);
    await page.getByRole("button", { name: "編集" }).click();
    const dialog = page.getByRole("dialog", { name: "Initiative を編集" });
    await dialog.getByLabel("名前").fill("検索基盤の刷新 v2");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    const saved = await nod.me.getInitiative(String(target.id));
    expect([saved.name, saved.description]).toEqual(["検索基盤の刷新 v2", description]);
  });
});

test.describe("Sprint", () => {
  test.use({ dataset: "sprint-history" });
  test("現在の採択集合をSprintでまとめ、固定とnoneへ切り替えられる", async ({ page }) => {
    await page.goto("/issues?sprint=current&groupBy=sprint");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["実行 127", "実行 141"]);
    await page.getByRole("combobox", { name: "Sprint", exact: true }).selectOption("none");
    await expect(page.getByText("候補のみ", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Sprint", exact: true }).selectOption("");
    await expect(page).not.toHaveURL(/sprint=/);
  });
  test("未解決の保存条件を外さず、範囲を広げずに表示する", async ({ page, nod }) => {
    await nod.me.createView({ name: "未解決", filter: { sprint: "unresolved:cycle:99" } });
    await page.goto("/views/2");
    await expect(page.getByText("条件の Sprint（unresolved:cycle:99）が見つかりません")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Sprint", exact: true })).toHaveValue("unresolved:cycle:99");
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(0);
  });
});
