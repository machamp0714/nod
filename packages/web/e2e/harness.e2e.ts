import { expect, test, waitForServerEvents } from "./fixtures";
import { resetData, restartApiServer } from "./support/nod";

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

  test("データを入れ直すたびに追加データが消え、各 ID が同じ値から始まる", async ({ nod }) => {
    // ほかのテストの実行順に依存させず、同じデータセットの復元を3回確かめる。
    for (let round = 0; round < 3; round += 1) {
      await resetData("harness");
      expect((await nod.me.listWorkspaces()).map(({ id, key }) => ({ id, key }))).toEqual([{ id: 1, key: "API" }]);
      expect((await nod.me.queryIssues({})).issues.map((issue) => issue.id)).toEqual(["API-1"]);
      expect(await nod.me.listProjects()).toEqual([]);
      expect(await nod.me.listViews()).toEqual([]);
      const seeded = await nod.me.getIssue("API-1");
      expect(seeded.questions).toEqual([]);
      expect(seeded.documents).toEqual([]);

      const { workspace } = await nod.me.initWorkspace({ path: nod.repo(`extra-${round}`), key: "EXTRA", name: "追加" });
      expect(workspace.id).toBe(2);
      const project = await nod.me.createProject({ name: `追加の Project ${round}` });
      expect(project.id).toBe(1);
      const view = await nod.me.createView({ name: `追加の View ${round}`, filter: {} });
      expect(view.id).toBe(1);
      const issue = await nod.me.createIssue({ workspaceId: 1, title: `追加の Issue ${round}` });
      expect(issue.id).toBe("API-2");
      const question = await nod.me.askQuestion("API-1", `追加の質問 ${round}`);
      expect(question.question.id).toBe(1);
      const document = await nod.me.attachDocument(
        { issueRef: "API-1" },
        { path: nod.writeFile(`docs/reset-${round}.md`, "# 初期化の確認") },
      );
      expect(document.id).toBe(1);
    }
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
  // 初期化後に server の DB 接続と data_version の基準を作り直す。
  // 待ち時間や、初期化由来の change を受け取ったかどうかには依存しない。
  await restartApiServer();
  await page.goto("/issues");
  // ページの中で購読を開き、ready を受けてから書く（ready の前に書いた変更は change として届かないため）
  const initialVersion = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const events = new EventSource("/api/events");
        const target = window as unknown as { nodChange: Promise<number> };
        target.nodChange = new Promise((done) =>
          events.addEventListener("change", (event) => {
            events.close();
            done(JSON.parse((event as MessageEvent<string>).data).dataVersion as number);
          }),
        );
        events.addEventListener("ready", (event) => {
          resolve(JSON.parse((event as MessageEvent<string>).data).dataVersion as number);
        });
      }),
  );
  await nod.me.initWorkspace({ path: nod.repo("nod"), key: "NOD", name: "nod" });
  const version = await page.evaluate(() => (window as unknown as { nodChange: Promise<number> }).nodChange);
  expect(version).toBeGreaterThan(initialVersion);
});

test("画面を開くと SSE に接続し、html に data-server-events=ready を出す", async ({ page }) => {
  await page.goto("/issues");
  await waitForServerEvents(page);
});
