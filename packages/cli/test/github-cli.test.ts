// packages/cli/test/github-cli.test.ts
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// gh の代わりに NOD_GH で起動する偽のコマンド。user・POST・Issue の取得に決めた出力を返し、引数を記録する
function fakeGh(): { path: string; log: string } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo "$@" >> "${log}"`,
      'case "$*" in',
      '  *"github.com user"*) echo alice; exit 0 ;;',
      `  *"-X POST"*) printf 'HTTP/2.0 201 Created\\r\\n\\r\\n{"number":41,"html_url":"https://github.com/example/api-server/issues/41"}'; exit 0 ;;`,
      `  *"repos/example/api-server/issues/7"*) echo '{"number":7,"html_url":"https://github.com/example/api-server/issues/7"}'; exit 0 ;;`,
      "esac",
      'echo "gh: Not Found (HTTP 404)" >&2; exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  writeFileSync(log, "");
  return { path, log };
}

function fixture() {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  git(cwd, "remote", "add", "origin", "git@github.com:Example/API-Server.git");
  const gh = fakeGh();
  const env = { NOD_GH: gh.path };
  return { db, cwd, gh, env };
}

test("nod workspace github: 未設定なら origin の候補を示し、人は設定・解除できる。LLM は変えられない", async () => {
  const { db, cwd, env } = fixture();
  const shown = await runNod(["workspace", "github", "show"], { cwd, db, env });
  expect(shown.stdout).toContain("example/api-server");
  const llm = await runNod(["workspace", "github", "set", "example/api-server", "--json"], { cwd, db, env, actor: "codex" });
  expect(llm.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const set = await runNod(["workspace", "github", "set", "Example/API-Server", "--json"], { cwd, db, env, actor: "me" });
  expect(set.json.repo).toBe("example/api-server");
  const cleared = await runNod(["workspace", "github", "clear", "--json"], { cwd, db, env, actor: "me" });
  expect(cleared.json.repo).toBeNull();
});

test("nod issue publish: LLM は --dry-run だけ。非対話では送らない。--json は --dry-run 専用", async () => {
  const { db, cwd, gh, env } = fixture();
  await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor: "me" });
  const created = (await runNod(["issue", "create", "検索を速くする", "-d", "API-1 の続き", "--json"], { cwd, db, env, actor: "me" })).json;
  const dry = await runNod(["issue", "publish", created.id, "--dry-run", "--json"], { cwd, db, env, actor: "codex" });
  expect(dry.exitCode).toBe(0);
  expect(dry.json).toMatchObject({ issueId: created.id, repo: "example/api-server", ghLogin: "alice", title: "検索を速くする" });
  expect(dry.json.findings.map((f: { rule: string }) => f.rule)).toEqual(["issue_id"]);
  expect((await runNod(["issue", "publish", created.id, "--json"], { cwd, db, env, actor: "codex" })).json.error.code).toBe("INVALID_ARGS");
  const llm = await runNod(["issue", "publish", created.id], { cwd, db, env, actor: "codex" });
  expect(llm.exitCode).toBe(1);
  expect(llm.stderr).toContain("FORBIDDEN_FOR_LLM");
  await runNod(["issue", "update", created.id, "-d", "続きの作業"], { cwd, db, env, actor: "me" });
  const human = await runNod(["issue", "publish", created.id], { cwd, db, env, actor: "me" });
  expect(human.exitCode).toBe(1);
  expect(human.stderr).toContain("NOT_INTERACTIVE");
  expect(readFileSync(gh.log, "utf8")).not.toContain("-X POST");
});

test("nod issue link-github / unlink-github: 人は紐付け・解除でき、PR と LLM は拒否する", async () => {
  const { db, cwd, env } = fixture();
  await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor: "me" });
  const created = (await runNod(["issue", "create", "検索", "--json"], { cwd, db, env, actor: "me" })).json;
  const url = "https://github.com/example/api-server/issues/7";
  expect((await runNod(["issue", "link-github", created.id, url, "--json"], { cwd, db, env, actor: "codex" })).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await runNod(["issue", "link-github", created.id, "https://github.com/example/api-server/pull/7", "--json"], { cwd, db, env, actor: "me" })).json.error.code).toBe("INVALID_ARGS");
  const linked = await runNod(["issue", "link-github", created.id, url, "--json"], { cwd, db, env, actor: "me" });
  expect(linked.json.link).toMatchObject({ number: 7, origin: "link" });
  const branch = await runNod(["issue", "branch-name", created.id], { cwd, db, env, actor: "me" });
  expect(branch.stdout).toBe("issue-7\n");
  const unlinked = await runNod(["issue", "unlink-github", created.id, "--json"], { cwd, db, env, actor: "me" });
  expect(unlinked.json.link).toBeNull();
});

test("nod issue publish --clear-unknown --json は INVALID_ARGS（--json は --dry-run 専用）", async () => {
  const { db, cwd, env } = fixture();
  const created = (await runNod(["issue", "create", "検索", "--json"], { cwd, db, env, actor: "me" })).json;
  const r = await runNod(["issue", "publish", created.id, "--clear-unknown", "--json"], { cwd, db, env, actor: "me" });
  expect(r.json.error.code).toBe("INVALID_ARGS");
});
