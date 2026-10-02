import { expect, test } from "./fixtures";
import { closeDisplay, columnChip, openDisplay, setColumn } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const DEFAULT_HEADERS = ["優先度", "ID", "Status", "Title", "Project", "Workspace", "担当", "更新日時"];

// #196：一覧の行を design/nod.pen「11 Issues」（O7KCp3）の行に合わせる。
// 優先度（アイコン 14）、ID（幅 72）、Status（アイコン 14 だけ）、題名、Project（幅 132）、Workspace（幅 96）、担当（18 の丸）、更新日時（幅 56）。
// 表示設定のチップは「Display Popover｜表示列（行見本に合わせる）」（U6jFNg）の順（#174・#196）
test("行は 優先度・ID・Status のアイコン・題名・Project・Workspace・担当・更新日時 の順で、Pencil の位置と幅に並ぶ", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { priority: 1, assignee: "codex", projectRef: "1" });
  await nod.me.updateIssue("API-7", { priority: 0, assignee: null, projectRef: null });
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("columnheader")).toHaveText(DEFAULT_HEADERS);

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
  await expect(cells("API-4").nth(2)).toHaveText("API-4");
  // Status はアイコンだけを出し、名前は支援技術とツールチップに出す
  const status = cells("API-4").nth(3);
  const statusName = (await status.locator("[title]").getAttribute("title")) ?? "";
  expect(["Backlog", "Todo", "In Progress", "In Review", "Needs Clarification"]).toContain(statusName);
  await expect(page.locator('tr[data-issue-row="API-4"]').getByRole("cell", { name: statusName, exact: true })).toHaveCount(1);
  const statusIcon = await status.evaluate((td) => {
    const svg = td.querySelector("svg") as SVGElement;
    const text = td.querySelector("span > span") as HTMLElement;
    return { size: `${svg.getBoundingClientRect().width}x${svg.getBoundingClientRect().height}`, textWidth: text.getBoundingClientRect().width };
  });
  expect(statusIcon).toEqual({ size: "14x14", textWidth: 1 });
  // Project は箱のアイコン 12 と名前、担当は 18 の丸（未割り当ては枠だけ）
  const project = cells("API-4").nth(5);
  await expect(project).toHaveText("検索 API の高速化");
  expect(await project.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width)).toBe(12);
  await expect(cells("API-7").nth(5)).toHaveText("");
  await expect(cells("API-4").nth(6)).toHaveText("api-server");
  const assignee = cells("API-4").nth(7);
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
  await expect(cells("API-7").nth(7).locator("[title='未割り当て']")).toHaveCount(1);
  // 右端は更新日時。更新したばかりの行は相対表記、ツールチップに日時を出す
  const updated = cells("API-4").nth(8);
  await expect(updated).toHaveText(/^(たった今|\d+分前)$/);
  await expect(updated).toHaveAttribute("title", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await expect(updated).toHaveCSS("font-size", "11.5px");
  await expect(cells("API-4")).toHaveCount(9);

  // 行の中の位置と幅（行の左端から。一括編集のチェックがあるので「Issues｜一括編集」AZzPu と同じ：チェック 12、優先度 36、ID 60、Status 142、題名 166）
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
    const row = main.querySelector('tr[data-issue-row="API-4"]') as HTMLElement;
    const r = row.getBoundingClientRect();
    const tds = [...row.querySelectorAll("td")];
    // セルの中身の箱（余白を除く）
    const content = (td: Element) => {
      const b = td.getBoundingClientRect();
      const css = getComputedStyle(td);
      const left = b.x + Number.parseFloat(css.paddingLeft);
      return { left, width: b.right - Number.parseFloat(css.paddingRight) - left };
    };
    const x = (el: Element) => Math.round(el.getBoundingClientRect().x - r.x);
    const fromRight = (td: Element) => ({ right: Math.round(r.right - content(td).left), width: Math.round(content(td).width) });
    return {
      heights: [...new Set(rows.map((row) => row.getBoundingClientRect().height))],
      drift: Math.round(drift * 100) / 100,
      overflow: { page: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth },
      left: {
        checkbox: x(tds[0]!.querySelector("input") as Element),
        priority: x(tds[1]!.querySelector("svg") as Element),
        id: Math.round(content(tds[2]!).left - r.x),
        idWidth: Math.round(content(tds[2]!).width),
        status: x(tds[3]!.querySelector("svg") as Element),
        title: x(tds[4]!.querySelector("a") as Element),
      },
      // 行の右端から（Pencil の行 幅 1172：Project 828、Workspace 970、担当 1076、更新日時 1104）
      right: { project: fromRight(tds[5]!), workspace: fromRight(tds[6]!), assignee: Math.round(r.right - (tds[7]!.querySelector("[title]") as Element).getBoundingClientRect().x), updated: fromRight(tds[8]!) },
    };
  });
  console.log(`[list-columns] row ${JSON.stringify(m)}`);
  expect(m.heights).toEqual([44]);
  expect(m.drift).toBeLessThanOrEqual(2.5);
  expect(m.overflow).toEqual({ page: 0, main: 0 });
  expect(m.left).toEqual({ checkbox: 12, priority: 36, id: 60, idWidth: 72, status: 142, title: 166 });
  expect(m.right).toEqual({ project: { right: 344, width: 132 }, workspace: { right: 202, width: 96 }, assignee: 96, updated: { right: 68, width: 56 } });

  // チップは 優先度・Status・未決事項・Workspace・Project・担当・PR・見積もり・期限 の順。未決事項・PR・見積もり・期限は既定で出さない
  const chips = (await openDisplay(page)).getByRole("group", { name: "リストの表示列" }).getByRole("button");
  await expect(chips).toHaveText(["優先度", "Status", "未決事項", "Workspace", "Project", "担当", "PR", "見積もり", "期限"]);
  for (const name of ["優先度", "Status", "Workspace", "Project", "担当"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "true");
  for (const name of ["未決事項", "PR", "見積もり", "期限"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "false");
  await setColumn(page, "優先度", false);
  await setColumn(page, "担当", false);
  await expect(page.getByRole("columnheader")).toHaveText(["ID", "Status", "Title", "Project", "Workspace", "更新日時"]);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.getByRole("columnheader")).toHaveText(["ID", "Status", "Title", "Project", "Workspace", "更新日時"]);
  // 戻った先の最初の /issues は表示設定のクエリがないため、保存した列（#218）で開く
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole("columnheader")).toHaveText(["ID", "Status", "Title", "Project", "Workspace", "更新日時"]);
});

test("優先度の列を外すと、ID がチェックの次（36）に来る", async ({ page }) => {
  await page.goto(`/issues?columns=${encodeURIComponent(JSON.stringify(["status", "workspace"]))}`);
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const m = await page.evaluate(() => {
    const row = document.querySelector("main tbody tr[data-issue-row]") as HTMLElement;
    const r = row.getBoundingClientRect();
    const tds = [...row.querySelectorAll("td")];
    const css = getComputedStyle(tds[1]!);
    const b = tds[1]!.getBoundingClientRect();
    return { checkbox: Math.round((tds[0]!.querySelector("input") as Element).getBoundingClientRect().x - r.x), id: Math.round(b.x + Number.parseFloat(css.paddingLeft) - r.x), idWidth: Math.round(b.width - Number.parseFloat(css.paddingLeft) - Number.parseFloat(css.paddingRight)) };
  });
  expect(m).toEqual({ checkbox: 12, id: 36, idWidth: 72 });
});

test("未決事項・PR・見積もり・期限は既定で出さず、チップで出すと Workspace と担当の間に並ぶ", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.locator('tr[data-issue-row="API-9"]')).not.toContainText("2 / 6");
  for (const name of ["未決事項", "PR", "見積もり", "期限"]) await setColumn(page, name, true);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "見積もり", "期限", "担当", "更新日時"]);
  await expect(page.locator('tr[data-issue-row="API-9"] td').nth(7)).toHaveText("2 / 6");
  // 未決事項を列で出しているときは、題名の横の未決ピルを重ねて出さない（w4l2KK）
  await expect(page.locator('tr[data-issue-row="API-9"]').getByText(/^未決 /)).toHaveCount(0);
  await expect(page.locator('tr[data-issue-row="API-7"] td').nth(8).getByRole("link", { name: "#128" })).toBeVisible();
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.locator('tr[data-issue-row="API-9"] td').nth(7)).toHaveText("2 / 6");
  // 「11 Issues｜行：未決事項・PR の列を出したとき」（w4l2KK）：未決事項と PR のセルは幅 56、見積もり 44、期限 132
  const widths = await page.locator('tr[data-issue-row="API-9"] td').evaluateAll((tds) =>
    tds.slice(7, 11).map((td) => {
      const css = getComputedStyle(td);
      return Math.round(td.getBoundingClientRect().width - Number.parseFloat(css.paddingLeft) - Number.parseFloat(css.paddingRight));
    }),
  );
  expect(widths).toEqual([56, 56, 44, 132]);
});

// design/nod.pen「11 Issues｜行：未決ピル」（a21Zf）：未回答の未決事項がある行だけ、題名の横に「未決 決定数/総数」を出す。
// 並びは 題名 → 作業状況 → 未決 → 完了候補。列を出さなくても未決の件数が分かる
test("未回答の未決事項がある行に未決ピルを出し、すべて決まった行と未決事項のない行には出さない", async ({ page, nod }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const pill = page.locator('tr[data-issue-row="API-9"]').getByText("未決 2/6", { exact: true });
  await expect(pill).toBeVisible();
  const m = await pill.evaluate((el) => {
    const css = getComputedStyle(el);
    const link = el.parentElement?.querySelector("a") as HTMLElement;
    return { height: el.getBoundingClientRect().height, padding: css.padding, radius: css.borderTopLeftRadius, font: `${css.fontSize} ${css.fontWeight}`, gap: Math.round(el.getBoundingClientRect().x - link.getBoundingClientRect().right), dots: el.children.length };
  });
  console.log(`[list-columns] open pill ${JSON.stringify(m)}`);
  expect(m).toEqual({ height: 21, padding: "2px 7px", radius: "10px", font: "11px 500", gap: 8, dots: 0 });
  const colors = await pill.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = "color: var(--ask); background: var(--ask-soft)";
    el.append(probe);
    const want = { color: getComputedStyle(probe).color, background: getComputedStyle(probe).backgroundColor };
    probe.remove();
    return { want, got: { color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor } };
  });
  expect(colors.got).toEqual(colors.want);
  // 未決ピルのある行は、未回答のある Issue と一致する
  const pills = await page.locator("main tbody tr[data-issue-row]").evaluateAll((rows) => rows.filter((row) => /未決 \d+\/\d+/.test(row.textContent ?? "")).map((row) => row.getAttribute("data-issue-row")));
  console.log(`[list-columns] rows with open pill ${JSON.stringify(pills)}`);
  expect(pills).toContain("API-9");
  expect(pills.length).toBeLessThan(13);
  // すべて回答すると消える
  const open = (await nod.me.getIssue("API-9")).questions.filter((q) => q.answer === null);
  expect(open).toHaveLength(4);
  for (const q of open) await nod.me.answerQuestion("API-9", "決定", { questionId: q.id });
  await expect(page.locator('tr[data-issue-row="API-9"]').getByText(/^未決 /)).toHaveCount(0);
  expect(await page.locator("main tbody tr[data-issue-row]").evaluateAll((rows) => [...new Set(rows.map((row) => row.getBoundingClientRect().height))])).toEqual([44]);
});

test("列を明示した #174・#196 より前の URL は、その列のまま復元する", async ({ page }) => {
  await page.goto(`/issues?columns=${encodeURIComponent(JSON.stringify(["status", "questions", "workspace", "pr"]))}`);
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("columnheader")).toHaveText(["ID", "Status", "Title", "Workspace", "未決事項", "PR", "更新日時"]);
  for (const name of ["優先度", "Project", "担当"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "false");
  await setColumn(page, "Project", true);
  await expect(page.getByRole("columnheader")).toHaveText(["ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "更新日時"]);
  // #196 より前の既定（未決事項・PR を含む7列）を明示した URL も、その列のまま出して URL に残す
  await page.goto(`/issues?columns=${encodeURIComponent(JSON.stringify(["priority", "status", "questions", "workspace", "project", "assignee", "pr"]))}`);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "担当", "更新日時"]);
  await expect(page).toHaveURL(/columns=/);
});

test("#196 より前の既定の列を明示して保存した View は、その列のまま開き「変更あり」にならない", async ({ page, nod }) => {
  const view = await nod.me.createView({ name: "旧既定の列", filter: {}, display: { columns: ["priority", "status", "questions", "workspace", "project", "assignee", "pr"] } });
  await page.goto(`/views/${view.id}`);
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "担当", "更新日時"]);
  await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/columns=/);
});

test("狭い幅（1280）でも、ページと Main に横スクロールが出ない", async ({ page }) => {
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

// プレビューを開くと一覧の幅が狭くなる。design/nod.pen「Issues｜プレビュー」（A3zK7）は Project と Workspace を外し、優先度・担当・更新日時を残す。
// 表示設定で足した 未決事項・PR・見積もり・期限 も、題名の幅を保つため外す（表示設定のチップはそのまま）
for (const width of [1280, 1440]) {
  test(`幅 ${width} でプレビューを開くと Project・Workspace と足した列を外し、題名の列の幅を保つ`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/issues?preview=API-12&columns=${encodeURIComponent(JSON.stringify(["priority", "status", "questions", "workspace", "project", "assignee", "pr", "estimate", "dueDate"]))}`);
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
    expect(m.headers).toEqual(["優先度", "ID", "Status", "Title", "担当", "更新日時"]);
    expect(m.page).toBe(0);
    expect(m.titleWidth).toBeGreaterThanOrEqual(200);
    // 表示設定のチップは変えず、プレビューを閉じると列が戻る
    for (const name of ["優先度", "Workspace", "Project", "担当", "未決事項", "PR"]) await expect(await columnChip(page, name)).toHaveAttribute("aria-pressed", "true");
    await closeDisplay(page);
    await page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
    await expect(page.getByRole("columnheader")).toHaveText(["優先度", "ID", "Status", "Title", "Project", "Workspace", "未決事項", "PR", "見積もり", "期限", "担当", "更新日時"]);
  });
}

test("Project 詳細では Project の列を既定で出さず、チップで出すと URL に残る", async ({ page }) => {
  const without = DEFAULT_HEADERS.filter((name) => name !== "Project");
  await page.goto("/projects/1");
  await expect(page.locator("main tbody tr[data-issue-row]").first()).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveText(without);
  await expect(await columnChip(page, "Project")).toHaveAttribute("aria-pressed", "false");
  await expect(page).not.toHaveURL(/columns=/);
  await setColumn(page, "Project", true);
  await expect(page.getByRole("columnheader")).toHaveText(DEFAULT_HEADERS);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.getByRole("columnheader")).toHaveText(DEFAULT_HEADERS);
  await setColumn(page, "Project", false);
  await expect(page.getByRole("columnheader")).toHaveText(without);
  await expect(page).not.toHaveURL(/columns=/);
});

test("My issues は担当が me と LLM に分かれるため、担当の列を既定で出す", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { assignee: "me" });
  await page.goto("/my-issues");
  await expect(page.locator("main tbody tr[data-issue-row]").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "担当", exact: true }).first()).toBeVisible();
  await expect(await columnChip(page, "担当")).toHaveAttribute("aria-pressed", "true");
  await setColumn(page, "担当", false);
  await expect(page.getByRole("columnheader", { name: "担当", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/columns=/);
  await page.reload();
  await expect(page.locator("main tbody tr[data-issue-row]").first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "担当", exact: true })).toHaveCount(0);
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
