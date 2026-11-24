// packages/cli/test/github-cli.test.ts
import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// gh の代わりに NOD_GH で起動する偽のコマンド。user・POST・Issue の取得に決めた出力を返し、引数を記録する
function fakeGh(): { path: string; log: string; payload: string } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  const payload = join(dir, "payload.json");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo "$@" >> "${log}"`,
      'case "$*" in',
      '  *"github.com user"*) echo alice; exit 0 ;;',
      `  *"-X POST"*) while [ "$1" != "--input" ]; do shift; done; cat "$2" > "${payload}"; if [ -f "${dir}/unknown" ]; then echo invalid; exit 0; fi; printf 'HTTP/2.0 201 Created\\r\\n\\r\\n{"number":41,"html_url":"https://github.com/example/api-server/issues/41"}'; exit 0 ;;`,
      `  *"repos/example/api-server/issues/7"*) echo '{"number":7,"html_url":"https://github.com/example/api-server/issues/7"}'; exit 0 ;;`,
      "esac",
      'echo "gh: Not Found (HTTP 404)" >&2; exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  writeFileSync(log, "");
  return { path, log, payload };
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

test("nod workspace github: 書き手によらず公開先を設定・解除できる", async () => {
  const { db, cwd, env } = fixture();
  const shown = await runNod(["workspace", "github", "show"], { cwd, db, env });
  expect(shown.stdout).toContain("example/api-server");
  const set = await runNod(["workspace", "github", "set", "Example/API-Server", "--json"], { cwd, db, env, actor: "codex" });
  expect(set.json.repo).toBe("example/api-server");
  expect(set.json.updatedBy).toBe("codex");
  const cleared = await runNod(["workspace", "github", "clear", "--json"], { cwd, db, env, actor: "codex" });
  expect(cleared.json.repo).toBeNull();
});

test("nod issue publish: dry-runは送らず、--yesなら非対話でも書き手によらず送る", async () => {
  const { db, cwd, gh, env } = fixture();
  await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor: "me" });
  const created = (await runNod(["issue", "create", "検索を速くする", "-d", "API-1 の続き。#12 も見る", "--json"], { cwd, db, env, actor: "me" })).json;
  const dry = await runNod(["issue", "publish", created.id, "--dry-run", "--json"], { cwd, db, env, actor: "codex" });
  expect(dry.exitCode).toBe(0);
  expect(dry.json).toMatchObject({
    issueId: created.id,
    repo: "example/api-server",
    ghLogin: "alice",
    title: "検索を速くする",
    body: "この Issue の続き。#12 も見る",
    original: { title: "検索を速くする", body: "API-1 の続き。#12 も見る" },
    changes: [{ field: "body", line: 1, column: 1, before: "API-1", after: "この Issue", rule: "issue_id" }],
  });
  expect(dry.json.findings.map((f: { rule: string; text: string }) => [f.rule, f.text])).toEqual([["issue_ref", "#12"]]);
  expect((await runNod(["issue", "publish", created.id, "--json"], { cwd, db, env, actor: "codex" })).json.error.code).toBe("INVALID_ARGS");
  const llm = await runNod(["issue", "publish", created.id], { cwd, db, env, actor: "codex" });
  expect(llm.exitCode).toBe(1);
  expect(llm.stderr).toContain("LEAK_DETECTED");
  await runNod(["issue", "update", created.id, "-d", "続きの作業"], { cwd, db, env, actor: "me" });
  const human = await runNod(["issue", "publish", created.id], { cwd, db, env, actor: "me" });
  expect(human.exitCode).toBe(1);
  expect(human.stderr).toContain("NOT_INTERACTIVE");
  expect(readFileSync(gh.log, "utf8")).not.toContain("-X POST");
  const noYes = await runNod(["issue", "publish", created.id], { cwd, db, env, actor: "codex" });
  expect(noYes.stderr).toContain("NOT_INTERACTIVE");
  for (const actor of ["me", "codex", "claude-code", "omp"]) {
    const issue = (await runNod(["issue", "create", "検索を速くする", "-d", "続きの作業", "--json"], { cwd, db, env, actor: "me" })).json;
    const sent = await runNod(["issue", "publish", issue.id, "--yes"], { cwd, db, env, actor });
    expect(sent.exitCode).toBe(0);
    expect(sent.stdout).toContain("https://github.com/example/api-server/issues/41");
    expect(JSON.parse(readFileSync(gh.payload, "utf8"))).toEqual({ title: "検索を速くする", body: "続きの作業" });
    await runNod(["issue", "unlink-github", issue.id], { cwd, db, env, actor });
  }
  expect(readFileSync(gh.log, "utf8").split("\n").filter((line) => line.includes("-X POST"))).toHaveLength(4);
});

test("nod issue link-github / unlink-github: LLMも紐付け・解除でき、PRは拒否する", async () => {
  const { db, cwd, env } = fixture();
  await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor: "me" });
  const created = (await runNod(["issue", "create", "検索", "--json"], { cwd, db, env, actor: "me" })).json;
  const url = "https://github.com/example/api-server/issues/7";
  expect((await runNod(["issue", "link-github", created.id, "https://github.com/example/api-server/pull/7", "--json"], { cwd, db, env, actor: "me" })).json.error.code).toBe("INVALID_ARGS");
  const linked = await runNod(["issue", "link-github", created.id, url, "--json"], { cwd, db, env, actor: "codex" });
  expect(linked.json.link).toMatchObject({ number: 7, origin: "link" });
  const branch = await runNod(["issue", "branch-name", created.id], { cwd, db, env, actor: "me" });
  expect(branch.stdout).toBe("issue-7\n");
  const unlinked = await runNod(["issue", "unlink-github", created.id, "--json"], { cwd, db, env, actor: "codex" });
  expect(unlinked.json.link).toBeNull();
});

test("nod issue publish --clear-unknown --json は INVALID_ARGS（--json は --dry-run 専用）", async () => {
  const { db, cwd, env } = fixture();
  const created = (await runNod(["issue", "create", "検索", "--json"], { cwd, db, env, actor: "me" })).json;
  const r = await runNod(["issue", "publish", created.id, "--clear-unknown", "--json"], { cwd, db, env, actor: "me" });
  expect(r.json.error.code).toBe("INVALID_ARGS");
});

test("結果不明の解除は全書き手に--yesが必要で、省略時は再送を防ぎ続ける", async () => {
  for (const actor of ["me", "codex", "claude-code", "omp"]) {
    const { db, cwd, gh, env } = fixture();
    await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor });
    const issue = (await runNod(["issue", "create", "検索", "--json"], { cwd, db, env, actor: "me" })).json;
    writeFileSync(join(gh.path, "..", "unknown"), "");
    const unknown = await runNod(["issue", "publish", issue.id, "--yes"], { cwd, db, env, actor });
    expect(unknown.stderr).toContain("GITHUB_RESULT_UNKNOWN");
    const denied = await runNod(["issue", "publish", issue.id, "--clear-unknown"], { cwd, db, env, actor });
    expect(denied.stderr).toContain("CONFIRM_REQUIRED");
    const retry = await runNod(["issue", "publish", issue.id, "--yes"], { cwd, db, env, actor });
    expect(retry.stderr).toContain("GITHUB_RESULT_UNKNOWN");
    const cleared = await runNod(["issue", "publish", issue.id, "--clear-unknown", "--yes"], { cwd, db, env, actor });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toContain("結果不明の送信を解除しました");
    expect(readFileSync(gh.log, "utf8").split("\n").filter((line) => line.includes("-X POST"))).toHaveLength(1);
    const after = await runNod(["issue", "publish", issue.id, "--dry-run", "--json"], { cwd, db, env, actor });
    expect(after.json.blockers).toEqual([]);
  }
});

test("端末では--yesなしで全文と[y/N]を表示し、yだけで送る", async () => {
  for (const answer of ["n", "y"]) {
    const { db, cwd, gh, env } = fixture();
    await runNod(["workspace", "github", "set", "example/api-server"], { cwd, db, env, actor: "codex" });
    const issue = (await runNod(["issue", "create", "検索", "-d", "公開する本文", "--json"], { cwd, db, env, actor: "me" })).json;
    let output = "";
    let answered = false;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "issue", "publish", issue.id], {
      cwd,
      env: { ...process.env, ...env, NOD_ACTOR: "codex", NOD_DB: db, NOD_ORCA: "0" },
      terminal: {
        cols: 120,
        rows: 40,
        data(terminal, data) {
          output += Buffer.from(data).toString();
          if (!answered && output.includes("[y/N]")) {
            answered = true;
            terminal.write(`${answer}\n`);
          }
        },
      },
    });
    try {
      expect(await proc.exited).toBe(0);
      expect(output).toContain("宛先: example/api-server");
      expect(output).toContain("gh アカウント: alice");
      expect(output).toContain("タイトル: 検索");
      expect(output).toContain("公開する本文");
      expect(output).toContain("[y/N]");
      const posts = readFileSync(gh.log, "utf8").split("\n").filter((line) => line.includes("-X POST"));
      expect(posts).toHaveLength(answer === "y" ? 1 : 0);
      if (answer === "y") expect(JSON.parse(readFileSync(gh.payload, "utf8"))).toEqual({ title: "検索", body: "公開する本文" });
      else expect(output).toContain("送信しませんでした");
    } finally {
      if (proc.exitCode === null) proc.kill();
      proc.terminal?.close();
    }
  }
});
