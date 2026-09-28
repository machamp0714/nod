import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "issue-list" });

for (const path of ["/issues", "/views/1", "/projects/1"]) {
  for (const layout of ["list", "board"]) {
    test(`${path} ${layout}: 説明検索とWorkspace表示を再読み込みできる`, async ({ page, nod }) => {
      await nod.me.updateIssue("API-12", { description: "Users 日本語 ÉCOLE %_" });
      await nod.me.updateIssue("NOD-5", { projectRef: "1" });
      if (path.startsWith("/views")) await nod.me.updateView(1, { filter: {} });
      await page.goto(`${path}?layout=${layout}`);
      await page.getByLabel("グループ化", { exact: true }).selectOption("workspace");
      await expect(page.getByRole("region", { name: "Workspace API", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Workspace NOD", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("workspace");
      for (const q of ["users", "日本語", "école", "%_"]) {
        await page.getByRole("textbox", { name: "検索", exact: true }).fill(q);
        await expect(page.getByRole("region", { name: "Workspace API", exact: true }).getByRole("link", { name: "検索 API の N+1 を解消", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Workspace NOD", exact: true })).toHaveCount(0);
      }
      await page.getByRole("textbox", { name: "検索", exact: true }).fill("存在しない文字列");
      await expect(page.getByText("該当する Issue はありません", { exact: true })).toHaveCount(1);
      await page.getByRole("textbox", { name: "検索", exact: true }).fill("");
      await page.getByLabel("グループ化", { exact: true }).selectOption("none");
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
    await page.getByRole("tablist", { name: "表示" }).getByRole("tab", { name: "Board" }).click();
    await expect(page.getByRole("region", { name: "Todo", exact: true }).getByRole("link", { name: "API-12", exact: true })).toBeVisible();
    await waitForServerEvents(page);
    await nod.me.updateIssue("API-12", { status: "done" });
    await expect(page.getByRole("region", { name: "Todo", exact: true })).not.toContainText("API-13");
    await nod.me.updateIssue("API-12", { status: "in_progress" });
    await expect(page.getByRole("region", { name: "Todo", exact: true })).toContainText("API-13");
    if (path !== "/projects/1") await page.getByText("Filter", { exact: true }).click();
    await page.getByLabel("ブロック", { exact: true }).selectOption("false");
    await expect(page.getByRole("region", { name: "Todo", exact: true })).not.toContainText("API-13");
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

test("手動でTodoへ戻すと作業中の表示が消え、検索しても件数カードは変わらない", async ({ page, nod }) => {
  await nod.codex.startIssue("API-4");
  await page.goto("/issues?layout=board");
  await waitForServerEvents(page);
  await expect(page.getByRole("region", { name: "In Progress", exact: true })).toContainText("作業中");
  await nod.me.updateIssue("API-4", { status: "todo" });
  const todo=page.getByRole("region", { name: "Todo", exact: true });
  await expect(todo).toContainText("API-4");
  await expect(todo).not.toContainText("作業中");
  await expect(page.getByRole("button", { name: "Ready 2", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("存在しない");
  await expect(page.getByRole("button", { name: "Ready 2", exact: true })).toBeVisible();
});

test("Projectの固定条件はURLで解除できず、カンバンはTriageだけのWorkspaceを出さない", async ({ page, nod }) => {
  await nod.me.relateIssue("NOD-6", { blocks: "NOD-5" });
  await page.goto("/projects/1?project=3&blocked=true");
  await expect(page.getByRole("table")).toContainText("API-13");
  await expect(page.getByRole("table")).not.toContainText("NOD-5");
  const { workspace }=await nod.me.initWorkspace({path:nod.repo("triage-only"),key:"TRI",name:"Triage専用"});
  await nod.codex.createIssue({workspaceId:workspace.id,title:"未受入"});
  await page.goto("/issues?groupBy=workspace");
  await expect(page.getByRole("region",{name:"Workspace TRI",exact:true})).toBeVisible();
  await page.getByRole("tablist", { name: "表示" }).getByRole("tab", { name: "Board" }).click();
  await expect(page.getByRole("region",{name:"Workspace TRI",exact:true})).toHaveCount(0);
});
