import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 実際の gh の代わりに NOD_GH で起動する偽のコマンド。引数を記録し、list と view に決めた出力を返す（GitHub には触れない）
function fakeGh(list: unknown[], comments: Record<number, unknown[]> = {}): { path: string; log: string } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  const listFile = join(dir, "list.json");
  writeFileSync(listFile, JSON.stringify(list));
  const views = Object.entries(comments)
    .map(([n, c]) => {
      const file = join(dir, `view-${n}.json`);
      writeFileSync(file, JSON.stringify({ comments: c }));
      return `  view) [ "$3" = "${n}" ] && cat "${file}" && exit 0 ;;`;
    })
    .join("\n");
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> "${log}"\ncase "$2" in\n  list) cat "${listFile}"; exit 0 ;;\n${views}\nesac\necho '{"comments":[]}'\n`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

const LIST = [
  {
    number: 3,
    title: "ログインが遅い",
    body: "再現手順",
    state: "OPEN",
    stateReason: "",
    labels: [{ name: "bug" }],
    assignees: [{ login: "alice" }],
    author: { login: "bob" },
    createdAt: "2026-03-01T00:00:00Z",
    closedAt: null,
    url: "https://github.com/example/api-server/issues/3",
  },
  {
    number: 1,
    title: "済んだ件",
    body: "",
    state: "CLOSED",
    stateReason: "COMPLETED",
    labels: [],
    assignees: [],
    author: { login: "bob" },
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: "2026-01-05T00:00:00Z",
    url: "https://github.com/example/api-server/issues/1",
  },
];

test("nod import github: --dry-run は対応を示し（LLM も可）、実行は人だけ・再実行では重複しない（#77）", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  const gh = fakeGh(LIST, { 3: [{ author: { login: "carol" }, body: "再現しました", createdAt: "2026-03-02T00:00:00Z" }] });
  const opts = { cwd, db, env: { NOD_GH: gh.path } };

  const dry = await runNod(["import", "github", "example/api-server", "--dry-run", "--state", "all"], { ...opts, actor: "claude-code" });
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain("GitHub example/api-server（all）から API へ: 2 件を読みました（新規 2 件・取り込み済み 0 件）");
  expect(dry.stdout).toContain("#1  CLOSED/COMPLETED  → done  済んだ件");
  expect(dry.stdout).toContain("#3  OPEN  → triage  ログインが遅い  [bug]");
  expect(dry.stdout).toContain("dry-run のため変更していません");
  expect(readFileSync(gh.log, "utf8").trim().split("\n")).toHaveLength(1);

  const llm = await runNod(["import", "github", "example/api-server", "--json"], { ...opts, actor: "claude-code" });
  expect(llm.json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const run = await runNod(["import", "github", "example/api-server", "--state", "all"], opts);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain("取り込みました: 2 件（API-1, API-2）");
  const issue = (await runNod(["issue", "show", "API-2", "--json"], opts)).json;
  expect(issue.status).toBe("triage");
  expect(issue.labels).toEqual(["bug"]);
  expect(issue.activity.some((a: { kind: string; body?: string }) => a.kind === "comment" && a.body?.includes("@carol が GitHub でコメント"))).toBe(true);
  expect((await runNod(["issue", "show", "API-1", "--json"], opts)).json.status).toBe("done");

  const again = await runNod(["import", "github", "example/api-server", "--state", "all", "--json"], opts);
  expect(again.json.imported).toEqual([]);
  expect(again.json.skipped.map((s: { id: string }) => s.id)).toEqual(["API-1", "API-2"]);
});

test("nod import github: 引数の誤りを gh を起動する前に拒む", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  const gh = fakeGh(LIST);
  const opts = { cwd, db, env: { NOD_GH: gh.path } };
  for (const args of [["example"], ["example/api", "--limit", "0"], ["example/api", "--limit", "x"], ["example/api", "--state", "closed"], ["example/api", "--open-status", "done"]]) {
    expect((await runNod(["import", "github", ...args, "--dry-run", "--json"], opts)).json.error.code).toBe("INVALID_ARGS");
  }
  expect(() => readFileSync(gh.log, "utf8")).toThrow();
});
