import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { acceptAndActivate, plannedSprint } from "./support/sprint-planning";

// Board のカードを別の列（または Hidden columns の行）へドラッグして status を変える

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const card = (page: Page, id: string) => page.getByRole("article").filter({ hasText: id });
const hiddenRow = (page: Page, name: string) => page.getByRole("region", { name: "Hidden columns" }).getByRole("listitem").filter({ hasText: name });
const statusOf = async (page: Page, id: string) => (await (await page.request.get(`/api/issues/${id}`)).json()).status as string;

async function seed(nod: import("./support/nod").NodData) {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  const todo = (await nod.me.createIssue({ workspaceId: ws.id, title: "D1 ドラッグする" })).id;
  await nod.me.updateIssue(todo, { status: "todo" });
  const doing = (await nod.me.createIssue({ workspaceId: ws.id, title: "D2 作業中" })).id;
  await nod.me.updateIssue(doing, { status: "in_progress" });
  return { todo, doing, ws };
}

for (const context of ["Workspace", "View", "Project"] as const) {
  test(`${context} の共有Boardでも保存した列と再読み込みが一致する`, async ({ page, nod }) => {
    const { todo, doing } = await seed(nod);
    let path = "/issues?workspace=API&layout=board&groupBy=none";
    if (context === "View") {
      const view = await nod.me.createView({ name: "ドラッグ回帰", filter: { workspace: "API" } });
      path = `/views/${view.id}?layout=board&groupBy=none`;
    } else if (context === "Project") {
      const project = await nod.me.createProject({ name: "ドラッグ回帰" });
      for (const id of [todo, doing]) await nod.me.updateIssue(id, { projectRef: String(project.id) });
      path = `/projects/${project.id}?layout=board&groupBy=none`;
    }
    await page.goto(path);
    await card(page, todo).dragTo(column(page, "In Progress"));
    await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("in_progress");
    await page.reload();
    await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("in_progress");
  });
}

test("カードを別の列に落とすと status が変わり、その列に移る", async ({ page, nod }) => {
  const { todo } = await seed(nod);
  await page.goto("/issues?layout=board");
  await expect(card(page, todo)).toBeVisible();

  await card(page, todo).dragTo(column(page, "In Progress"));
  await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("in_progress");
  await page.reload();
  await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("in_progress");
});

test("カードを Hidden columns の行に落とすと status が変わり、その列が現れる", async ({ page, nod }) => {
  const { todo } = await seed(nod);
  await page.goto("/issues?layout=board");
  await expect(hiddenRow(page, "Done")).toBeVisible();

  await card(page, todo).dragTo(hiddenRow(page, "Done"));
  await expect(column(page, "Done").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("done");
  await page.reload();
  await expect(column(page, "Done").getByRole("article").filter({ hasText: todo })).toBeVisible();
  expect(await statusOf(page, todo)).toBe("done");
});

for (const target of ["Todo", "Needs Clarification"]) {
  test(`${target} への無効なドロップは保存せず、再読み込み後も元の状態を保つ`, async ({ page, nod }) => {
    const { todo } = await seed(nod);
    const before = await (await page.request.get(`/api/issues/${todo}`)).json();
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && request.url().endsWith("/api/issues/bulk-update")) writes.push(request.url());
    });
    await page.goto("/issues?layout=board");
    await card(page, todo).dragTo(target === "Todo" ? column(page, target) : hiddenRow(page, target));
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    await page.reload();
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await (await page.request.get(`/api/issues/${todo}`)).json()).toMatchObject({ status: "todo", updatedAt: before.updatedAt });
    expect(writes).toEqual([]);
  });
}

test.describe("通信が失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/net::ERR_FAILED/] });

  test("失敗を示し保存も表示も元に保ち、通信復旧後のドロップを保存する", async ({ page, nod }) => {
    const { todo } = await seed(nod);
    await page.route("**/api/issues/bulk-update", route => route.abort("failed"));
    await page.goto("/issues?layout=board");
    await card(page, todo).dragTo(column(page, "In Progress"));
    await expect(page.getByRole("alert")).toContainText("server に接続できません");
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("todo");
    await page.reload();
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    await page.unroute("**/api/issues/bulk-update");
    await card(page, todo).dragTo(column(page, "In Progress"));
    await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("in_progress");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("遷移ルールで拒否されたとき", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("エラーを出し、カードは元の列に残る", async ({ page, nod }) => {
    const { todo } = await seed(nod);
    await nod.me.setTransitionRules("API", { forbidden: [{ from: "todo", to: "in_progress" }] });
    await page.goto("/issues?layout=board");

    await card(page, todo).dragTo(column(page, "In Progress"));
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(todo);
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("todo");
    await page.reload();
    await expect(column(page, "Todo").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("todo");
  });
});

test.describe("Sprint採択Issueの通常着手", () => {
  test("現在SprintのBoardでも通常ドロップで着手でき、再読込後も状態を保つ", async ({ page, nod }) => {
    const { todo, ws } = await seed(nod);
    const sprint = await acceptAndActivate(page, await plannedSprint(page, ws.key, [todo]));
    await page.goto(`/sprints/${sprint.id}?layout=board&groupBy=none`);
    await card(page, todo).dragTo(hiddenRow(page, "In Progress"));
    await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await statusOf(page, todo)).toBe("in_progress");
    await page.reload();
    await expect(column(page, "In Progress").getByRole("article").filter({ hasText: todo })).toBeVisible();
    expect(await statusOf(page, todo)).toBe("in_progress");
  });
});
