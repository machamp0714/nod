import { beforeAll, describe, expect, test } from "bun:test";
import { GUIDE } from "../src/guide";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const llm = (args: string[]) => runNod(args, { cwd: repo, db, actor: "claude-code" });
const me = (args: string[]) => runNod(args, { cwd: repo, db });

async function newIssue(): Promise<string> {
  return (await me(["issue", "create", "--json", "作業ログ"])).json.id;
}

describe("nod issue log --kind", () => {
  test("種類を付けて残すと JSON に logKind が載り、show に日本語の種類が出る", async () => {
    const id = await newIssue();
    const r = await llm(["issue", "log", id, "N+1 を避けるため IN 句にした", "--kind", "rationale", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ body: "N+1 を避けるため IN 句にした", logKind: "rationale" });
    await llm(["issue", "log", id, "調べ始めた"]);
    const shown = await llm(["issue", "show", id, "--json"]);
    expect(shown.json.activity.filter((a: { kind: string }) => a.kind === "comment").map((a: { logKind: string }) => a.logKind)).toEqual([
      "rationale",
      "progress",
    ]);
    const text = (await llm(["issue", "show", id])).stdout;
    expect(text).toContain("claude-code [判断根拠]: N+1 を避けるため IN 句にした");
    expect(text).toContain("claude-code [経過]: 調べ始めた");
  });

  test("通常のコメントには種類を表示しない", async () => {
    const id = await newIssue();
    await me(["issue", "comment", id, "ふつうのコメント"]);
    const text = (await me(["issue", "show", id])).stdout;
    expect(text).toContain("me: ふつうのコメント");
  });

  test("リスト外の種類は INVALID_ARGS で、候補を示す", async () => {
    const id = await newIssue();
    const r = await llm(["issue", "log", id, "x", "--kind", "thought", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
    expect(r.json.error.message).toContain("progress|plan|rationale|command|test|blocker");
  });

  test("秘密値らしき値は SECRET_DETECTED で拒否し、値をエラーに出さない", async () => {
    const id = await newIssue();
    const secret = "ghp_" + "c".repeat(36);
    const r = await llm(["issue", "log", id, `GITHUB_TOKEN=${secret}`, "--kind", "command", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("SECRET_DETECTED");
    expect(r.stdout + r.stderr).not.toContain(secret);
    const shown = await llm(["issue", "show", id, "--json"]);
    expect(shown.json.activity.filter((a: { kind: string }) => a.kind === "comment")).toEqual([]);
  });

  test("4,000 文字を超えると INVALID_ARGS", async () => {
    const id = await newIssue();
    const r = await llm(["issue", "log", id, "a".repeat(4001), "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });
});

describe("手引き", () => {
  test("作業ログの種類・長文・機微情報の扱いを書く", () => {
    for (const kind of ["progress", "plan", "rationale", "command", "test", "blocker"]) {
      expect(GUIDE).toContain(`\`${kind}\``);
    }
    expect(GUIDE).toContain("--kind");
    expect(GUIDE).toContain("4000 文字");
    expect(GUIDE).toMatch(/^- SECRET_DETECTED：/m);
    expect(GUIDE).toContain("内部の思考");
  });
});
