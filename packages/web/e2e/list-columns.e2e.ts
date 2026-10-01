import { expect, test } from "./fixtures";
import { closeDisplay, columnChip, openDisplay, setColumn } from "./support/issue-list";

test.use({ dataset: "issue-list" });

// #174：一覧の行に優先度（アイコン）・Project・担当を出し、表示設定で切り替える。
// design/nod.pen「11 Issues」（O7KCp3）の行と「Display Popover｜表示列に優先度・担当」（o64gix）のチップに合わせる
test("行頭に優先度のアイコン、題名の後ろに Project と担当を出し、表示設定のチップで切り替える", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { priority: 1, assignee: "codex", projectRef: "1" });
  await nod.me.updateIssue("API-7", { priority: 0, assignee: null, projectRef: null });
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);

  const cells = (id: string) => page.locator(`tr[data-issue-row="${id}"] td`);
  // 選択のチェックボックスの次が優先度。Urgent は赤い circle-alert、名前は支援技術とツールチップに出す
  const urgent = cells("API-4").nth(1);
  await expect(urgent).toHaveText("Urgent");
  await expect(urgent.locator("[title]")).toHaveAttribute("title", "Urgent");
  const icon = await urgent.locator("svg").evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    return { size: `${box.width}x${box.height}`, lucide: [...svg.classList].find((name) => name.startsWith("lucide-") && name !== "lucide-icon") };
  });
  console.log(`[list-columns] urgent icon ${JSON.stringify(icon)}`);
  expect(icon).toEqual({ size: "14x14", lucide: "lucide-circle-alert" });
  await expect(cells("API-7").nth(1)).toHaveText("No priority");
  // Project は箱のアイコン 12 と名前、担当は 18 の丸（未割り当ては枠だけ）
  const project = cells("API-4").nth(6);
  await expect(project).toHaveText("検索 API の高速化");
  expect(await project.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width)).toBe(12);
  await expect(cells("API-7").nth(6)).toHaveText("");
  const assignee = cells("API-4").nth(8);
  await expect(assignee).toHaveText(/codex$/);
  // アバターの頭文字は支援技術に出さず、セルの名前は担当の名前だけにする
  await expect(page.locator('tr[data-issue-row="API-4"]').getByRole("cell", { name: "codex", exact: true })).toHaveCount(1);
  await expect(assignee.locator("[title='codex']")).toHaveText("X");
  await expect(assignee.locator("[aria-hidden='true']").filter({ has: page.locator("[title='codex']") })).toHaveCount(1);
  const avatar = await assignee.locator("[title='codex']").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return `${box.width}x${box.height} ${getComputedStyle(el).borderTopLeftRadius}`;
  });
  expect(avatar).toBe("18x18 50%");
  await expect(cells("API-7").nth(8).locator("[title='未割り当て']")).toHaveCount(1);
  // 行の高さ 44 と中心そろえは変えず、横スクロールも出さない
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const rows = [...main.querySelectorAll("tbody tr[data-issue-row]")];
    let drift = 0;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      for (const el of row.querySelectorAll("td > *, td > div > *")) {
        const b = el.getBoundingClientRect();
        if (b.width <= 1 || b.height <= 1) continue;
        drift = Math.max(drift, Math.abs(b.y + b.height / 2 - (r.y + r.height / 2)));
      }
    }
    return {
      heights: [...new Set(rows.map((row) => row.getBoundingClientRect().height))],
      drift: Math.round(drift * 100) / 100,
      overflow: { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth },
    };
  });
  console.log(`[list-columns] row ${JSON.stringify(m)}`);
  expect(m.heights).toEqual([44]);
  expect(m.drift).toBeLessThanOrEqual(2.5);
  expect(m.overflow).toEqual({ page: 0, main: 0 });

  // チップは 優先度・Status・未決事項・Workspace・Project・担当・PR・見積もり・期限 の順
  const chips = (await openDisplay(page)).getByRole("group", { name: "リストの表示列" }).getByRole("button");
  await expect(chips).toHaveText(["優先度", "Status", "未決事項", "Workspace", "Project", "担当", "PR", "見積もり", "期限"]);
  for (const name of ["優先度", "Project", "担当"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "true");
  await setColumn(page, "優先度", false);
  await setColumn(page, "担当", false);
  await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Project", "Workspace", "PR"]);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Project", "Workspace", "PR"]);
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
});

test("列を明示した #174 より前の URL は、その列のまま復元する", async ({ page }) => {
  await page.goto(`/issues?columns=${encodeURIComponent(JSON.stringify(["status", "questions", "workspace", "pr"]))}`);
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Workspace", "PR"]);
  for (const name of ["優先度", "Project", "担当"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "false");
  await setColumn(page, "Project", true);
  await expect(page.getByRole("columnheader")).toHaveText(["Status", "ID", "Title", "未決事項", "Project", "Workspace", "PR"]);
});

test("狭い幅（1280）で3列を出しても、ページと Main に横スクロールが出ない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const title = main.querySelector("tbody tr[data-issue-row] td:has(a[href^='/issues/'])") as HTMLElement;
    return { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth, titleWidth: Math.round(title.getBoundingClientRect().width) };
  });
  console.log(`[list-columns] 1280 ${JSON.stringify(m)}`);
  expect({ page: m.page, main: m.main }).toEqual({ page: 0, main: 0 });
  expect(m.titleWidth).toBeGreaterThanOrEqual(200);
});

// プレビューを開くと一覧の幅が狭くなる。題名の列がつぶれないよう、プレビュー中は Workspace に加えて Project・担当の列を表から外す
// （表示設定のチップはそのまま。プレビューの中に Project と担当が出る）
for (const width of [1280, 1440]) {
  test(`幅 ${width} でプレビューを開いても、題名の列の幅を保つ`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/issues?preview=API-12");
    await expect(page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true })).toBeVisible();
    await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
    const m = await page.evaluate(() => {
      const main = document.querySelector("main") as HTMLElement;
      const title = main.querySelector("tbody tr[data-issue-row] td:has(a[href^='/issues/'])") as HTMLElement;
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        tableWidth: Math.round((main.querySelector("table") as HTMLElement).getBoundingClientRect().width),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        headers: [...main.querySelectorAll("table")[0]!.querySelectorAll("th")].map((th) => th.textContent),
      };
    });
    console.log(`[list-columns] preview ${width} ${JSON.stringify(m)}`);
    expect(m.headers).toEqual(["Status", "ID", "Title", "未決事項", "PR"]);
    expect(m.page).toBe(0);
    expect(m.titleWidth).toBeGreaterThanOrEqual(200);
    // 表示設定のチップは変えず、プレビューを閉じると列が戻る
    for (const name of ["優先度", "Workspace", "Project", "担当"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "true");
    await closeDisplay(page);
    await page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
    await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
  });
}

test("Project 詳細では Project の列を既定で出さず、チップで出すと URL に残る", async ({ page }) => {
  await page.goto("/projects/1");
  await expect(page.locator("main tbody tr[data-issue-row]").first()).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Workspace", "担当", "PR"]);
  await expect(await columnChip(page, "Project")).toHaveAttribute("aria-pressed", "false");
  await expect(page).not.toHaveURL(/columns=/);
  await setColumn(page, "Project", true);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
  await setColumn(page, "Project", false);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Workspace", "担当", "PR"]);
  await expect(page).not.toHaveURL(/columns=/);
});

test("My issues の担当タブでは担当の列を既定で出さず、委任中タブでは出す", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { assignee: "me" });
  await page.goto("/my-issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(1);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "PR"]);
  await expect(await columnChip(page, "担当")).toHaveAttribute("aria-pressed", "false");
  await setColumn(page, "担当", true);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "Status", "ID", "Title", "未決事項", "Project", "Workspace", "担当", "PR"]);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "担当", exact: true })).toHaveCount(1);

  await page.goto("/my-issues?tab=delegated");
  await expect(page.locator("main tbody tr[data-issue-row]").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "担当", exact: true }).first()).toBeVisible();
  await expect(await columnChip(page, "担当")).toHaveAttribute("aria-pressed", "true");
});

// priority の条件は CLI・API で作った View だけが持つ。Web では ready・委任中と同じく、チップに出して外すことだけできる
test("View の優先度の条件をチップに出し、外して保存できる。絞り込みのパネルからは足せない", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { priority: 1 });
  const view = await nod.me.createView({ name: "急ぎ", filter: { priority: [1, 2] } });
  await page.goto(`/views/${view.id}`);
  const rows = page.locator("main tbody tr[data-issue-row]");
  await expect(rows.first()).toBeVisible();
  const narrowed = await rows.count();
  expect(narrowed).toBeLessThan(13);
  for (const cell of await rows.locator("td:nth-child(2)").allTextContents()) expect(["Urgent", "High"]).toContain(cell);
  const chips = page.getByRole("group", { name: "絞り込み条件" });
  await expect(chips).toContainText(/優先度\s*is\s*Urgent, High/);
  // 絞り込みのパネルには優先度の欄を出さない
  await page.getByText("Filter", { exact: true }).click();
  await expect(chips.getByRole("group", { name: "Status" })).toBeVisible();
  await expect(chips.getByRole("group", { name: "優先度" })).toHaveCount(0);
  await page.getByText("Filter", { exact: true }).click();

  await chips.getByRole("button", { name: "優先度 の条件を外す", exact: true }).click();
  await expect(chips).not.toContainText("優先度");
  await expect(rows).toHaveCount(13);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(chips).toContainText(/優先度\s*is\s*Urgent, High/);
  await expect(rows).toHaveCount(narrowed);

  await chips.getByRole("button", { name: "優先度 の条件を外す", exact: true }).click();
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
  const saved = (await (await page.request.get("/api/views")).json()) as { id: number; filter: Record<string, unknown> }[];
  expect(saved.find((v) => v.id === view.id)?.filter).toEqual({});
  await page.reload();
  await expect(rows).toHaveCount(13);
  await expect(chips).not.toContainText("優先度");
});
