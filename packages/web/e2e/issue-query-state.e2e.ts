import { expect, test, waitForServerEvents } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { chooseDisplay, closeDisplay, displaySelect, hiddenColumn, searchBox, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  for (const layout of ["list", "board"]) {
    test(`${path} ${layout}: 説明検索とWorkspace表示を再読み込みできる`, async ({ page, nod }) => {
      await nod.me.updateIssue("API-12", { description: "Users 日本語 ÉCOLE %_" });
      await nod.me.updateIssue("NOD-5", { projectRef: "1" });
      if (path.startsWith("/views")) await nod.me.updateView(1, { filter: {} });
      await page.goto(`${path}?layout=${layout}`);
      await chooseDisplay(page, "グループ化", "Workspace");
      await expect(page.getByRole("region", { name: "Workspace API", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Workspace NOD", exact: true })).toBeVisible();
      await page.reload();
      await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "workspace");
      for (const q of ["users", "日本語", "école", "%_"]) {
        await (await searchBox(page)).fill(q);
        await expect(page.getByRole("region", { name: "Workspace API", exact: true }).getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Workspace NOD", exact: true })).toHaveCount(0);
      }
      await (await searchBox(page)).fill("存在しない文字列");
      await expect(page.getByText("該当する Issue はありません", { exact: true })).toHaveCount(1);
      await (await searchBox(page)).fill("");
      await chooseDisplay(page, "グループ化", "なし");
      await expect(page.getByRole("region", { name: "Workspace API", exact: true })).toHaveCount(0);
    });
  }
}

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: ブロックFilterと元リンクがSSEで完了・再開に追従する`, async ({ page, nod }) => {
    await page.goto(path);
    if (path !== "/projects/1") await page.getByText("Filter", { exact: true }).click();
    await page.getByLabel("ブロック", { exact: true }).selectOption("true");
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
    await expect(page.getByRole("table")).toContainText("API-13");
    await expect(page.getByRole("table").getByRole("link", { name: "API-12", exact: true })).toHaveAttribute("href", "/issues/API-12");
    if (path !== "/projects/1") await page.getByText("Filter", { exact: true }).click();
    await setLayout(page, "Board");
    await closeDisplay(page);
    await expect(page.getByRole("region", { name: "Todo", exact: true }).getByRole("link", { name: "API-12", exact: true })).toBeVisible();
    await waitForServerEvents(page);
    await nod.me.updateIssue("API-12", { status: "done" });
    // ブロック中は API-13 だけなので、外れると Todo の列は 0 件になり Hidden columns へ移る
    await expect(page.getByRole("region", { name: "Todo", exact: true })).toHaveCount(0);
    await expect(hiddenColumn(page, "Todo")).toHaveText("Todo0");
    await nod.me.updateIssue("API-12", { status: "in_progress" });
    await expect(page.getByRole("region", { name: "Todo", exact: true })).toContainText("API-13");
    if (path !== "/projects/1") await page.getByText("Filter", { exact: true }).click();
    await page.getByLabel("ブロック", { exact: true }).selectOption("false");
    await expect(page.getByRole("article").filter({ hasText: "API-13" })).toHaveCount(0);
    await expect(page.getByRole("article").filter({ hasText: "API-12" })).toHaveCount(1);
    if (path !== "/views/1") {
      await page.reload();
      if (path === "/issues") await page.getByText("Filter", { exact: true }).click();
      await expect(page.getByLabel("ブロック", { exact: true })).toHaveValue("false");
    } else {
      await page.getByRole("button", { name: "変更を保存", exact: true }).click();
      await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toHaveCount(0);
      await page.reload();
      await page.getByText("Filter", { exact: true }).click();
      await expect(page.getByLabel("ブロック", { exact: true })).toHaveValue("false");
    }
  });
}

test("手動でTodoへ戻すと作業中の表示が消え、検索してもタブの件数は変わらない", async ({ page, nod }) => {
  await nod.codex.startIssue("API-4");
  await page.goto("/issues?layout=board");
  await waitForServerEvents(page);
  await expect(page.getByRole("region", { name: "In Progress", exact: true })).toContainText("作業中");
  await nod.me.updateIssue("API-4", { status: "todo" });
  const todo=page.getByRole("region", { name: "Todo", exact: true });
  await expect(todo).toContainText("API-4");
  await expect(todo).not.toContainText("作業中");
  await expect(page.getByRole("tab", { name: "Ready 2", exact: true })).toBeVisible();
  await (await searchBox(page)).fill("存在しない");
  await expect(page.getByText("該当する Issue はありません", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Hidden columns", exact: true }).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByRole("tab", { name: "Ready 2", exact: true })).toBeVisible();
});

test("Projectの固定条件はURLで解除できず、カンバンはTriageだけのWorkspaceを出さない", async ({ page, nod }) => {
  await nod.me.relateIssue("NOD-6", { blocks: "NOD-5" });
  await page.goto("/projects/1?project=3&blocked=true");
  await expect(page.getByRole("table")).toContainText("API-13");
  await expect(page.getByRole("table")).not.toContainText("NOD-5");
  const { workspace }=await nod.me.initWorkspace({path:nod.repo("triage-only"),key:"TRI",name:"Triage専用"});
  await nod.codex.createIssue({workspaceId:workspace.id,title:"未受入"});
  const canceled = await nod.me.createIssue({workspaceId:workspace.id,title:"中止済み"});
  await nod.me.updateIssue(canceled.id, { status: "canceled", reason: "表示対象外の検証" });
  await page.goto("/issues?groupBy=workspace");
  await expect(page.getByRole("region",{name:"Workspace TRI",exact:true})).toBeVisible();
  await setLayout(page, "Board");
  await expect(page.getByRole("region",{name:"Workspace TRI",exact:true})).toHaveCount(0);
});

const columnDescriptions = [
  ["Needs Clarification", "着手前に未決事項を確認する"],
  ["Backlog", "受け入れ済み・着手は後で"],
  ["Todo", "着手の対象・ブロック状況を確認"],
  ["In Progress", "作業中・進み具合を確認"],
  ["In Review", "作業報告を確認して承認・差し戻し"],
  ["Done", "完了した Issue"],
] as const;

// 6つの Status は、Issue があれば説明つきの列に、0 件なら Hidden columns の行（件数 0）に、必ずどちらかで出る
async function expectSixStatuses(scope: Page | Locator) {
  let columns = 0;
  for (const [name, description] of columnDescriptions) {
    const column = scope.getByRole("region", { name, exact: true });
    const hidden = hiddenColumn(scope, name);
    await expect(column.or(hidden)).toBeVisible();
    if ((await column.count()) > 0) {
      columns++;
      await expect(column.getByText(description, { exact: true })).toBeVisible();
      expect(await column.getByRole("article").count()).toBeGreaterThan(0);
    } else {
      await expect(hidden).toHaveText(`${name}0`);
    }
  }
  return columns;
}

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  test(`${path}: 6つのStatusは説明つきの列かHidden columnsに出て、検索・Workspaceでも保ち、Listには出ない`, async ({ page, nod }) => {
    await nod.me.updateIssue("NOD-5", { projectRef: "1" });
    if (path === "/views/1") await nod.me.updateView(1, { filter: {} });
    await page.goto(`${path}?layout=board`);
    expect(await expectSixStatuses(page)).toBeGreaterThan(0);
    // 検索で全列が 0 件になると、6つとも Hidden columns にまとまる（空の列と説明文は出さない）
    await (await searchBox(page)).fill("存在しない説明確認用");
    await expect(page.getByRole("region", { name: "Hidden columns", exact: true }).getByRole("listitem")).toHaveText(columnDescriptions.map(([name]) => `${name}0`));
    expect(await expectSixStatuses(page)).toBe(0);
    for (const [, description] of columnDescriptions) await expect(page.getByText(description, { exact: true })).toHaveCount(0);
    await chooseDisplay(page, "グループ化", "Workspace");
    await expect(page.getByText("該当する Issue はありません", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Hidden columns", exact: true })).toHaveCount(0);
    await (await searchBox(page)).fill("");
    for (const workspace of ["API", "NOD"]) {
      const group = page.getByRole("region", { name: `Workspace ${workspace}`, exact: true });
      await expect(group).toBeVisible();
      expect(await expectSixStatuses(group)).toBeGreaterThan(0);
    }
    await setLayout(page, "List");
    for (const [, description] of columnDescriptions) await expect(page.getByText(description, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Hidden columns", exact: true })).toHaveCount(0);
  });
}

for (const width of [1280, 1440]) {
  test(`${width}px: 列は幅 340、列見出しは全列同じ高さで、説明は1行に収まり、カードと重ならない`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/issues?layout=board");
    for (const grouping of ["なし", "Workspace"]) {
      await chooseDisplay(page, "グループ化", grouping);
      await closeDisplay(page);
      for (const [name, description] of columnDescriptions) {
        const columns = page.getByRole("region", { name, exact: true });
        await expect(columns.first().getByText(description, { exact: true })).toBeAttached();
        for (const column of await columns.all()) {
          const geometry = await column.evaluate((element) => {
            const header = element.querySelector("header")!;
            const hint = header.querySelector("p")!;
            const heading = header.querySelector("h2")!;
            const count = header.querySelector("span")!;
            const next = header.nextElementSibling!;
            const box = (node: Element) => node.getBoundingClientRect();
            const style = getComputedStyle(hint);
            return {
              hintBelowHeading: box(hint).top >= box(heading).bottom,
              countAfterHeading: box(count).left >= box(heading).right,
              contentBelowHint: box(next).top >= box(hint).bottom,
              hintFits: box(hint).left >= box(element).left && box(hint).right <= box(element).right,
              noTextOverflow: hint.scrollWidth <= hint.clientWidth,
              fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color,
              columnWidth: box(element).width, headHeight: box(header).height, hintHeight: box(hint).height,
            };
          });
          // design/nod.pen「Issues｜ボード」：列の幅 340、見出しは題名の行 46 と説明文の行 18 と下の 4 で 68
          expect(geometry).toEqual({ hintBelowHeading: true, countAfterHeading: true, contentBelowHint: true, hintFits: true, noTextOverflow: true, fontSize: "12px", lineHeight: "18px", color: "rgb(138, 145, 158)", columnWidth: 340, headHeight: 68, hintHeight: 18 });
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`board-${width}-${grouping}.png`), fullPage: true });
    }
  });
}

test("Ready・blockedのWorkspace表示でも列説明と絞り込みが両立する", async ({ page }) => {
  await page.goto("/issues?layout=board&groupBy=workspace&blocked=true");
  const group = page.getByRole("region", { name: "Workspace API", exact: true });
  await expect(group).toContainText("API-13");
  // ブロック中は API-13（Todo）だけなので、Todo が説明つきの列で、残りの5つは Hidden columns にまとまる
  expect(await expectSixStatuses(group)).toBe(1);
  await expect(group.getByRole("region", { name: "Todo", exact: true }).getByText("着手の対象・ブロック状況を確認", { exact: true })).toBeVisible();
  await page.goto("/issues?layout=board&groupBy=workspace&tab=ready");
  await expect(page.getByRole("link", { name: "OpenAPI の説明文を更新する", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("API-13");
  await expect(page.getByText("着手の対象・ブロック状況を確認", { exact: true }).first()).toBeVisible();
});

test("古い完了IssueもDone列に残る", async ({ page }) => {
  let oldDoneResponses = 0;
  await page.route(/\/api\/issues(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const rows = Array.isArray(body) ? body : body.issues;
    for (const issue of rows) if (issue.status === "done") {
      oldDoneResponses += 1;
      issue.updatedAt = "2020-01-01T00:00:00.000Z";
      issue.createdAt = "2020-01-01T00:00:00.000Z";
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/issues?layout=board");
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect.poll(() => oldDoneResponses).toBeGreaterThan(0);
  await expect(done).toContainText("NOD-3");
  await expect(done).toContainText("完了した Issue");
  await page.unrouteAll({ behavior: "wait" });
});
