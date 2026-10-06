// packages/cli/test/github-publish-command.test.ts
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, type GhRunner, type GhRunResult, getGithubState, initWorkspace, openDb, setWorkspaceGithubRepo } from "@nod/core";
import type { Cli } from "../src/context";
import { isYes, type PublishIo, runPublishCommand, visibleControls } from "../src/commands/github";
import { tempDb, tempDir } from "./helpers";

const exited = (stdout: string, exitCode = 0, stderr = ""): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr });

function fakeGh() {
  const calls: string[][] = [];
  const payloads: string[] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args.includes("user")) return exited("alice\n");
    if (args.includes("POST")) {
      payloads.push(await Bun.file(args[args.indexOf("--input") + 1]!).text());
      return exited(`HTTP/2.0 201 Created\r\n\r\n${JSON.stringify({ number: 41, html_url: "https://github.com/example/api-server/issues/41" })}`);
    }
    return exited("{}");
  };
  return { run, calls, payloads, posts: () => calls.filter((a) => a.includes("POST")).length };
}

function fakeIo(opts: { interactive?: boolean; answer?: boolean; onConfirm?: () => void } = {}): PublishIo & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    interactive: () => opts.interactive ?? true,
    write: (t) => out.push(t),
    confirm: async (q) => {
      out.push(q);
      opts.onConfirm?.();
      return opts.answer ?? true;
    },
  };
}

function fixture(repo: string | null = "example/api-server") {
  const db = openDb(tempDb());
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server", key: "API" }).workspace;
  const me = { db, actor: "me" };
  if (repo) setWorkspaceGithubRepo(me, "API", repo);
  const id = createIssue(me, { workspaceId: ws.id, title: "検索を速くする", description: "遅い" }).id;
  const cli: Cli = { db, ctx: me, json: false };
  return { db, cli, id };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

test("確認画面に宛先・アカウント・全文を出し、y で1回だけ作成する", async () => {
  const { db, cli, id } = fixture();
  const gh = fakeGh();
  const io = fakeIo();
  await runPublishCommand(cli, id, {}, io, { gh: gh.run });
  const shown = io.out.join("");
  expect(shown).toContain("example/api-server");
  expect(shown).toContain("alice");
  expect(shown).toContain("検索を速くする");
  expect(shown).toContain("[y/N]");
  expect(shown).toContain("https://github.com/example/api-server/issues/41");
  expect(gh.posts()).toBe(1);
  expect(getGithubState(db, id).link?.number).toBe(41);
});

test("N では送らない", async () => {
  const { cli, id } = fixture();
  const gh = fakeGh();
  const io = fakeIo({ answer: false });
  await runPublishCommand(cli, id, {}, io, { gh: gh.run });
  expect(io.out.join("")).toContain("送信しませんでした");
  expect(gh.posts()).toBe(0);
});

test("--title と --body-file で差し替え、確認のあとにファイルが変わっても確認した内容を送る", async () => {
  const { cli, id } = fixture();
  const file = join(tempDir(), "body.md");
  writeFileSync(file, "差し替えた本文\r\n2 行目");
  const gh = fakeGh();
  const io = fakeIo({ onConfirm: () => writeFileSync(file, "あとで変えた本文") });
  await runPublishCommand(cli, id, { title: "別のタイトル", bodyFile: file }, io, { gh: gh.run });
  expect(JSON.parse(gh.payloads[0]!)).toEqual({ title: "別のタイトル", body: "差し替えた本文\r\n2 行目" });
  expect(io.out.join("")).toContain("差し替えた本文");
});

test("非対話・LLM・検出あり・公開先未設定では送らない", async () => {
  const { cli, id } = fixture();
  const gh = fakeGh();
  expect(await codeOf(runPublishCommand(cli, id, {}, fakeIo({ interactive: false }), { gh: gh.run }))).toBe("NOT_INTERACTIVE");
  expect(await codeOf(runPublishCommand({ ...cli, ctx: { db: cli.db, actor: "codex" } }, id, {}, fakeIo(), { gh: gh.run }))).toBe("FORBIDDEN_FOR_LLM");
  expect(await codeOf(runPublishCommand(cli, id, { title: "API-1 の続き" }, fakeIo(), { gh: gh.run }))).toBe("LEAK_DETECTED");
  const unset = fixture(null);
  const git: GhRunner = async () => exited("git@github.com:Example/API-Server.git\n");
  let message = "";
  try {
    await runPublishCommand(unset.cli, unset.id, {}, fakeIo(), { gh: gh.run, git });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("nod workspace github set example/api-server");
  expect(gh.posts()).toBe(0);
});

test("--dry-run は送らず、検出を行番号付きで示す。--json は --dry-run と一緒にだけ使える", async () => {
  const { cli, id } = fixture();
  const gh = fakeGh();
  const logs: string[] = [];
  const original = console.log;
  console.log = (t: string) => logs.push(t);
  try {
    await runPublishCommand(cli, id, { dryRun: true, bodyFile: undefined, title: "NOD-4 と API-1" }, fakeIo(), { gh: gh.run });
  } finally {
    console.log = original;
  }
  expect(logs.join("\n")).toContain("タイトル 1 行 9 桁: API-1");
  expect(gh.posts()).toBe(0);
  expect(await codeOf(runPublishCommand({ ...cli, json: true }, id, {}, fakeIo(), { gh: gh.run }))).toBe("INVALID_ARGS");
});

test("--clear-unknown は --json とも、ほかの指定とも一緒に使えない", async () => {
  const { cli, id } = fixture();
  expect(await codeOf(runPublishCommand({ ...cli, json: true }, id, { clearUnknown: true }, fakeIo(), {}))).toBe("INVALID_ARGS");
  expect(await codeOf(runPublishCommand(cli, id, { clearUnknown: true, dryRun: true }, fakeIo(), {}))).toBe("INVALID_ARGS");
});

test("制御文字は見える形にし、改行・タブ・CRLF の \\r はそのまま", () => {
  expect(visibleControls("a\u001b[2Jb\tc\r\nd\re\u202ef")).toBe("a\\u{001b}[2Jb\tc\r\nd\\u{000d}e\\u{202e}f");
});

test("isYes は y・yes だけを承認とし、EOF・Ctrl-C（null）・ほかの入力は送らない", () => {
  for (const a of ["y", "Y", "yes", " yes ", "YES"]) expect(isYes(a)).toBe(true);
  for (const a of ["", "n", "no", "ye", "yess", null]) expect(isYes(a)).toBe(false);
});

test("--body-file が CRLF でも検出の行番号は LF と同じで、確認画面は CRLF の \\r を残し単独の \\r だけ見える形にする", async () => {
  const lines = async (text: string) => {
    const { cli, id } = fixture();
    const file = join(tempDir(), "body.md");
    writeFileSync(file, text);
    const logs: string[] = [];
    const original = console.log;
    console.log = (t: string) => logs.push(t);
    try {
      await runPublishCommand(cli, id, { dryRun: true, bodyFile: file }, fakeIo(), { gh: fakeGh().run });
    } finally {
      console.log = original;
    }
    return logs.join("\n");
  };
  const lf = await lines("1 行目\n2 行目\nAPI-1 です");
  const crlf = await lines("1 行目\r\n2 行目\r\nAPI-1 です");
  expect(lf).toContain("本文 3 行 1 桁: API-1");
  expect(crlf).toContain("本文 3 行 1 桁: API-1");
  expect(crlf).toContain("1 行目\r\n2 行目\r\n");

  const { cli, id } = fixture();
  const file = join(tempDir(), "body.md");
  writeFileSync(file, "a\r\nb\rc");
  const io = fakeIo({ answer: false });
  await runPublishCommand(cli, id, { bodyFile: file }, io, { gh: fakeGh().run });
  expect(io.out.join("")).toContain("a\r\nb\\u{000d}c");
});

test("done の Issue に結果不明の試行が残っていれば、ISSUE_CLOSED ではなく復旧の案内（GITHUB_RESULT_UNKNOWN）で止める", async () => {
  const { db, cli, id } = fixture();
  const timeout: GhRunner = async (args) => (args.includes("POST") ? { kind: "timeout" } : exited("alice\n"));
  expect(await codeOf(runPublishCommand(cli, id, {}, fakeIo(), { gh: timeout }))).toBe("GITHUB_RESULT_UNKNOWN");
  db.query("UPDATE issues SET status = 'done'").run();
  const gh = fakeGh();
  let message = "";
  try {
    await runPublishCommand(cli, id, {}, fakeIo(), { gh: gh.run });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("--clear-unknown");
  expect(gh.posts()).toBe(0);
});

test("nod のタイトルが 256 文字を超えると --dry-run で理由を示し、--title で短くすれば送れる", async () => {
  const { db, cli, id } = fixture();
  db.query("UPDATE issues SET title = ?").run("𠮷".repeat(257));
  const gh = fakeGh();
  const logs: string[] = [];
  const original = console.log;
  console.log = (t: string) => logs.push(t);
  try {
    await runPublishCommand(cli, id, { dryRun: true }, fakeIo(), { gh: gh.run });
  } finally {
    console.log = original;
  }
  expect(logs.join("\n")).toContain("公開できません: タイトルは 256 文字までです");
  expect(await codeOf(runPublishCommand(cli, id, {}, fakeIo(), { gh: gh.run }))).toBe("INVALID_ARGS");
  expect(gh.posts()).toBe(0);
  await runPublishCommand(cli, id, { title: "短いタイトル" }, fakeIo(), { gh: gh.run });
  expect(JSON.parse(gh.payloads[0]!).title).toBe("短いタイトル");
});
