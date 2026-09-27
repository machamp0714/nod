import { expect, test } from "./fixtures";

test.describe("データセットを入れたとき", () => {
  test.use({ dataset: "harness" });

  test("web の /api は e2e の server に届き、データセットの Workspace と Issue を返す", async ({ request, nod }) => {
    const workspaces = (await (await request.get("/api/workspaces")).json()) as { key: string; path: string }[];
    expect(workspaces.map((w) => w.key)).toEqual(["API"]);
    // 私の DB ではなく、e2e の一時ディレクトリの DB を使っている
    expect(workspaces[0]?.path).toBe(nod.repo("api-server"));
    const issue = await (await request.get("/api/issues/API-1")).json();
    expect(issue).toMatchObject({ title: "土台の確認に使う Issue", status: "in_progress", assignee: "claude-code" });
  });

  test("テストで足したデータは、次のテストの前に消える（1）", async ({ nod }) => {
    await nod.me.createProject({ name: "一時の Project" });
    expect((await nod.me.listProjects()).map((p) => p.name)).toEqual(["一時の Project"]);
  });

  test("テストで足したデータは、次のテストの前に消える（2）", async ({ nod }) => {
    expect(await nod.me.listProjects()).toEqual([]);
    const [workspace] = await nod.me.listWorkspaces();
    const created = await nod.me.createIssue({ workspaceId: workspace?.id ?? 0, title: "2つ目" });
    expect(created.id).toBe("API-2");
  });
});

test("既定では空の DB から始まる", async ({ request }) => {
  expect(await (await request.get("/api/workspaces")).json()).toEqual([]);
});

test("書き手を選んで core の操作を呼べ、失敗は code 付きの例外になる", async ({ nod }) => {
  const { workspace } = await nod.me.initWorkspace({ path: nod.repo("blog"), key: "BLOG", name: "blog" });
  const issue = await nod.claude.createIssue({ workspaceId: workspace.id, title: "LLM が起票した Issue" });
  expect(issue).toMatchObject({ id: "BLOG-1", status: "triage", createdBy: "claude-code" });
  await expect(nod.me.startIssue(issue.id)).rejects.toThrow(/^NOT_ACCEPTED: /);
});

test("別の接続での書き込みは、SSE の change として届く", async ({ page, nod }) => {
  await page.goto("/issues");
  // ページの中で購読を開き、ready を受けてから書く（ready の前に書いた変更は change として届かないため）
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const events = new EventSource("/api/events");
        const target = window as unknown as { nodChange: Promise<number> };
        target.nodChange = new Promise((done) =>
          events.addEventListener("change", (event) => {
            events.close();
            done(JSON.parse((event as MessageEvent<string>).data).dataVersion as number);
          }),
        );
        events.addEventListener("ready", () => resolve());
      }),
  );
  await nod.me.initWorkspace({ path: nod.repo("nod"), key: "NOD", name: "nod" });
  const version = await page.evaluate(() => (window as unknown as { nodChange: Promise<number> }).nodChange);
  expect(version).toEqual(expect.any(Number));
});
