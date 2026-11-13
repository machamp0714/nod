import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commit,
  exploreHandoff,
  git,
  gitOut,
  makeGitRepo,
  type PreparedWork,
  prepareCaseWork,
  put,
  reachRefute,
  refuteVerdict,
  registerRepo,
  runReview,
  type Sandbox,
  sandbox,
  sha256,
  tempNod,
} from "./code-review-review-helpers";

const read = (path: string) => readFileSync(path, "utf8");

interface Tally {
  responses: number;
  turns: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  totalTokens: number | null;
  maxContext: number | null;
  missing: string[];
  retries: { errors: { at: string; message: string }[]; credentialPins: string[] };
  outside?: number;
}
interface Source {
  path: string | null;
  sha256: string | null;
  unavailable: string | null;
}
interface Measured {
  source: Source;
  tally: Tally | null;
  unavailable: string | null;
}
interface StandaloneAgent extends Measured {
  agentId: string;
  time: { from: string | null; to: string | null; seconds: number | null };
}
interface Standalone {
  ok: boolean;
  range: { from: string; to: string };
  parent: Measured;
  agents: StandaloneAgent[];
  out: string;
}
interface Attempt extends Measured {
  role: string;
  attempt: number;
  agentId: string | null;
  startedAt: string;
  receivedAt: string | null;
  seconds: number | null;
  failure: string | null;
}
interface Section {
  name: string;
  owner: string;
  from: string;
  to: string;
  seconds: number;
  open: boolean;
  parent: Measured;
  attempts: string[];
}
interface UsageRecord {
  report: { from: string; to: string; seconds: number; sections: Section[]; parent: Measured; attempts: Attempt[] };
  final: { from: string; to: string; seconds: number; parent: Measured };
  comparison: { from: string | null; to: string; seconds: number | null; start: string; parent: Measured; attempts: Attempt[]; agentsTotal: number | null };
}
interface Stage {
  subcommand: string;
  startedAt: string;
  endedAt: string | null;
}
interface Agent {
  role: string;
  attempt: number;
  agentId: string | null;
  startedAt: string;
  receivedAt: string | null;
}

let seq = 0;
// omp のセッション記録の assistant の応答1件（外側の timestamp が記録の時刻。usage の欄は与えたものだけ）
function response(at: string, usage: Record<string, number>, o: { stop?: string; error?: string; tool?: { name: string; arguments: object } } = {}): string {
  seq++;
  return JSON.stringify({
    type: "message",
    id: `m${seq}`,
    timestamp: at,
    message: {
      role: "assistant",
      content: o.tool ? [{ type: "toolCall", id: `t${seq}`, name: o.tool.name, arguments: o.tool.arguments }] : [{ type: "text", text: "応答" }],
      usage,
      stopReason: o.stop ?? "toolUse",
      ...(o.error ? { errorMessage: o.error } : {}),
      model: "model-x",
      timestamp: 1,
    },
  });
}
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number) => ({ input, output, cacheRead, cacheWrite, totalTokens });
const session = (at: string, parentSession?: string) => JSON.stringify({ type: "session", version: 3, id: `s${++seq}`, timestamp: at, cwd: "/x", ...(parentSession ? { parentSession } : {}) });
const pin = (at: string) => JSON.stringify({ type: "credential_pin", id: `p${++seq}`, timestamp: at, provider: "p", hash: "h" });
const custom = (at: string) => JSON.stringify({ type: "custom", id: `c${++seq}`, timestamp: at, customType: "x", data: {} });
const user = (at: string) => JSON.stringify({ type: "message", id: `u${++seq}`, timestamp: at, message: { role: "user", content: [{ type: "text", text: "依頼" }] } });
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (at: string) => Date.parse(at);
const total = (n: number) => usage(n, 0, 0, 0, n);

describe("code-review の区間別の時間と使用量（review.ts usage・finalize の計測）", () => {
  test("任意のセッション記録と時刻の範囲: 開始を含み終了を含まない応答だけを応答単位で合計し、omp 内部の retry を分け、担当は別ファイルから集計して、取得できない値は 0 にしない", async () => {
    const s = sandbox();
    const dir = join(s.t, "sessions");
    const parent = join(dir, "2026-11-13T09-00-00-000Z_parent.jsonl");
    const F = "2026-11-13T10:00:00.000Z";
    const T = "2026-11-13T10:30:00.000Z";
    put(
      parent,
      lines(
        session("2026-11-13T09:00:00.000Z"),
        user("2026-11-13T09:59:59.000Z"),
        response("2026-11-13T09:59:59.999Z", usage(100000, 0, 0, 0, 100000)),
        response(F, usage(1000, 10, 0, 0, 1010)),
        response("2026-11-13T10:10:00.000Z", usage(0, 0, 0, 0, 0), { stop: "error", error: "429 rate limit" }),
        pin("2026-11-13T10:10:01.000Z"),
        response("2026-11-13T10:20:00.000Z", usage(200, 20, 5000, 300, 5520)),
        response("2026-11-13T10:29:59.999Z", usage(50, 5, 6000, 0, 6055), { stop: "stop" }),
        response(T, usage(999999, 0, 0, 0, 999999)),
      ),
    );
    const agentDir = join(dir, "2026-11-13T09-00-00-000Z_parent");
    put(
      join(agentDir, "AgentA.jsonl"),
      lines(
        session("2026-11-13T10:01:00.000Z", parent),
        response("2026-11-13T10:02:00.000Z", usage(100, 1, 0, 0, 101)),
        response("2026-11-13T10:05:00.000Z", usage(10, 2, 400, 0, 412), { stop: "stop" }),
        custom("2026-11-13T10:12:00.000Z"),
      ),
    );
    // cacheWrite の欄が無い応答がある担当
    put(join(agentDir, "AgentB.jsonl"), lines(session("2026-11-13T10:03:00.000Z", parent), response("2026-11-13T10:04:00.000Z", { input: 7, output: 1, cacheRead: 0, totalTokens: 8 }, { stop: "stop" })));
    const out = join(s.t, "measure");
    const args = ["--session", parent, "--from", F, "--to", T, "--agent", "AgentA", "--agent", "Missing", "--agent", "AgentB", "--out", out];
    const r = await runReview<Standalone>("usage", args, s);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const j = r.json as Standalone;
    expect(JSON.parse(read(join(out, "usage.json")))).toEqual(j);
    expect(j.parent.source).toMatchObject({ path: parent, sha256: sha256(read(parent)), unavailable: null });
    expect(j.range).toMatchObject({ from: F, to: T });
    expect(j.parent.tally).toMatchObject({
      responses: 4,
      turns: 3,
      input: 1250,
      output: 35,
      cacheRead: 11000,
      cacheWrite: 300,
      totalTokens: 12585,
      maxContext: 6050,
      missing: [],
      retries: { errors: [{ at: "2026-11-13T10:10:00.000Z", message: "429 rate limit" }], credentialPins: ["2026-11-13T10:10:01.000Z"] },
    });
    const [a, missing, b] = j.agents;
    expect(a?.agentId).toBe("AgentA");
    expect(a?.source.path).toBe(join(agentDir, "AgentA.jsonl"));
    expect(a?.source.sha256).toBe(sha256(read(join(agentDir, "AgentA.jsonl"))));
    expect(a?.tally).toMatchObject({ responses: 2, turns: 2, input: 110, output: 3, cacheRead: 400, cacheWrite: 0, totalTokens: 513, maxContext: 410, retries: { errors: [], credentialPins: [] } });
    // 担当の時間は記録の始まりから最終返答まで（その後の片付けの記録を含めない）
    expect(a?.time).toEqual({ from: "2026-11-13T10:01:00.000Z", to: "2026-11-13T10:05:00.000Z", seconds: 240 });
    expect(missing?.tally).toBeNull();
    expect(missing?.unavailable).toContain("無い");
    expect(missing?.unavailable).toContain(join(agentDir, "Missing.jsonl"));
    expect(b?.tally).toMatchObject({ responses: 1, input: 7, cacheWrite: null, totalTokens: 8, missing: ["cacheWrite"] });
    const md = read(join(out, "usage.md"));
    expect(md).toContain("取得できず");
    expect(md).toContain(sha256(read(parent)));

    // 記録が無い親は取得できず（0 にしない）。範囲の誤りと記録先の欠落は引数の誤り
    const none = await runReview<Standalone>("usage", ["--session", join(dir, "nothing.jsonl"), "--from", F, "--to", T, "--out", join(s.t, "none")], s);
    expect(none.exitCode).toBe(0);
    expect(none.json?.parent.tally).toBeNull();
    expect(none.json?.parent.unavailable).toContain("無い");
    expect((await runReview("usage", ["--session", parent, "--from", T, "--to", F, "--out", join(s.t, "x")], s)).exitCode).toBe(2);
    expect((await runReview("usage", ["--session", parent, "--from", F, "--to", T], s)).exitCode).toBe(2);
  });

  test("レビューの作業ディレクトリ: 段階と委譲の時刻から区間を作り、並列の探索と担当別・試行別の時間と使用量を分け、報告直前の値・保存後の確定値・MIN-33 比較用の値を別々に残す", async () => {
    const s = sandbox();
    const gh = join(s.bin, "failing-gh");
    writeFileSync(gh, "#!/bin/sh\necho 'gh: not available' >&2\nexit 1\n");
    chmodSync(gh, 0o755);
    s.env.NOD_GH = gh;
    const nod = tempNod(s);
    const repo = makeGitRepo(s, "app");
    registerRepo(nod.db, repo, "APP");
    const base = gitOut(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "feature");
    const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
    expect((await nod.run(["workspace", "rules", "set", "--text", "# 規約\n\n- 日本語で書く\n"], repo)).exitCode).toBe(0);
    const issue = (await nod.run(["--json", "issue", "create", "要求の Issue", "--description", "- a は 1 を返す\n- 失敗を記録する"], repo)).json.id as string;

    // 親のセッション記録（omp が PI_SESSION_FILE で渡す）。スキルの読み込みより前の応答と、スキルの読み込みの応答
    const parentFile = join(s.t, "sessions/2026-11-13T00-00-00-000Z_parent.jsonl");
    const agentDir = join(s.t, "sessions/2026-11-13T00-00-00-000Z_parent");
    const skillAt = iso(Date.now() - 5000);
    put(
      parentFile,
      lines(
        session(iso(Date.now() - 60000)),
        response(iso(Date.now() - 30000), total(1)),
        response(skillAt, total(10), { tool: { name: "read", arguments: { path: "skill://code-review" } } }),
      ),
    );
    const add = (...l: string[]) => appendFileSync(parentFile, lines(...l));
    const env = { PI_SESSION_FILE: parentFile };
    const W = join(s.t, "work/run");
    const prep = await runReview<{ ready: boolean }>("prepare", ["--work", W, "--repo", repo, "--mode", "commit", "--base", "main", "--head", head, "--issue", issue], s, env);
    expect(prep.json?.ready).toBe(true);
    const p: PreparedWork = { W, repo, base, head, clone: join(W, "repo") };
    const stages = () => JSON.parse(read(join(W, "parent/stages.json"))) as Stage[];
    const t0 = stages()[0]?.startedAt as string;
    expect(stages()[0]?.subcommand).toBe("prepare");
    // 開始の直前の応答は報告の値にも確定値にも入らず、開始ちょうどの応答は準備の区間に入る
    add(response(iso(ms(t0) - 1), total(100)), response(t0, total(1000)));

    const run = async (sub: string, args: string[]) => {
      const r = await runReview<{ valid?: boolean; ready?: boolean }>(sub, ["--work", W, ...args], s, env);
      expect(`${sub} ${args.join(" ")}: ${r.exitCode}`).toBe(`${sub} ${args.join(" ")}: 0`);
      return r.json;
    };
    const agents = () => JSON.parse(read(join(W, "parent/agents.json"))) as Agent[];
    const last = (role: string) => agents().filter((a) => a.role === role).at(-1) as Agent;

    // 探索: Standards の試行1は無効で隔離し、試行2へ委譲し直す。Spec は omp 内部の retry を含む
    await run("agent", ["--role", "standards", "--event", "start"]);
    const exploreStart = last("standards").startedAt;
    add(response(exploreStart, total(10000)));
    await run("agent", ["--role", "spec", "--event", "start"]);
    put(join(W, "standards/handoff.md"), exploreHandoff("standards", p).replace("定義名: code-reviewer-standards", "定義名: code-reviewer"));
    await run("agent", ["--role", "standards", "--event", "received", "--agent-id", "StdA"]);
    expect((await run("check-explore", ["--role", "standards"]))?.valid).toBe(false);
    await run("retire-attempt", ["--role", "standards", "--failure", "invalid", "--reason", "5節の3: 定義名"]);
    await run("agent", ["--role", "standards", "--event", "start"]);
    put(join(W, "spec/handoff.md"), exploreHandoff("spec", p));
    await run("agent", ["--role", "spec", "--event", "received", "--agent-id", "Spc"]);
    put(join(W, "standards/handoff.md"), exploreHandoff("standards", p));
    await run("agent", ["--role", "standards", "--event", "received", "--agent-id", "StdB"]);
    expect((await run("check-explore", ["--role", "standards"]))?.valid).toBe(true);
    expect((await run("check-explore", ["--role", "spec"]))?.valid).toBe(true);
    const byId = (id: string) => agents().find((a) => a.agentId === id) as Agent;
    const [std1, spc, std2] = [byId("StdA"), byId("Spc"), byId("StdB")];
    put(join(agentDir, "StdA.jsonl"), lines(session(std1.startedAt, parentFile), response(std1.startedAt, total(1000), { stop: "stop" })));
    // 担当の時間の終わり（受領）ちょうどの応答と、その後の片付けの記録は担当の値に入れない
    put(join(agentDir, "StdB.jsonl"), lines(session(std2.startedAt, parentFile), response(std2.startedAt, total(2000), { stop: "stop" }), response(std2.receivedAt as string, total(50)), custom(iso(ms(std2.receivedAt as string) + 60000))));
    put(
      join(agentDir, "Spc.jsonl"),
      lines(
        session(spc.startedAt, parentFile),
        pin(spc.startedAt),
        response(spc.startedAt, usage(0, 0, 0, 0, 0), { stop: "error", error: "529 overloaded" }),
        pin(spc.startedAt),
        response(spc.startedAt, usage(100, 0, 2900, 0, 3000), { stop: "stop" }),
      ),
    );

    // 反証（担当の記録が無い）。反証の検査の後の親の応答は最後の区間に入る
    await run("refute-input", []);
    await run("agent", ["--role", "refute", "--event", "start"]);
    put(join(W, "refute/verdict.md"), refuteVerdict(p, { acceptance: false }));
    await run("agent", ["--role", "refute", "--event", "received", "--agent-id", "Ref"]);
    expect((await run("check-refute", []))?.valid).toBe(true);
    add(response(new Date().toISOString(), total(100000)));

    // 保存の間（報告の組み立ての後・保存と照合の完了の前）と、保存の後の作業ログで、親の応答が記録されたことにする
    const append = join(s.t, "append.ts");
    writeFileSync(
      append,
      `import { appendFileSync } from "node:fs";\nconst n = Number(process.argv[3]);\nappendFileSync(process.argv[2], JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [], usage: { input: n, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n }, stopReason: "toolUse" } }) + "\\n");\n`,
    );
    const wrap = join(s.t, "nod-wrap.sh");
    writeFileSync(
      wrap,
      `#!/bin/sh\ncase "$*" in\n  *"doc create"*) "${process.execPath}" "${append}" "${parentFile}" 1000000 ;;\n  *"issue log"*) "${process.execPath}" "${append}" "${parentFile}" 7000000 ;;\nesac\nexec "${nod.env.NOD_CLI}" "$@"\n`,
    );
    chmodSync(wrap, 0o755);
    // --auto-check-rows は評価用の事例だけで使う
    expect((await runReview("finalize", ["--work", W, "--auto-check-rows", "pass"], s, env)).exitCode).toBe(2);
    const f = await runReview<{ status: string; reportStartedAt: string; savedAt: string; saved: boolean; logs: { summary: number | null }; documents: { report: { id: number } }; usage: { record: string } }>("finalize", ["--work", W], s, { ...env, NOD_CLI: wrap });
    expect(f.stderr).toBe("");
    expect(f.exitCode).toBe(0);
    const fin = f.json as NonNullable<typeof f.json>;
    expect(fin).toMatchObject({ status: "完了", saved: true });
    expect(fin.usage.record).toBe(join(W, "parent/usage.json"));
    const u = JSON.parse(read(join(W, "parent/usage.json"))) as UsageRecord;

    // (1) 報告に載せる値: prepare の開始から報告の組み立ての直前まで
    expect(u.report).toMatchObject({ from: t0, to: fin.reportStartedAt });
    expect(u.report.parent.tally?.totalTokens).toBe(1000 + 10000 + 100000);
    expect(u.report.parent.source.path).toBe(parentFile);
    const sec = (name: string) => u.report.sections.find((x) => x.name === name) as Section;
    expect(u.report.sections.map((x) => x.name)).toEqual(["準備", "探索（並列）", "引き渡しの検査", "反証", "反証の検査と仕上げ"]);
    expect(sec("準備")).toMatchObject({ owner: "親", from: t0, to: exploreStart });
    expect(sec("準備").parent.tally?.totalTokens).toBe(1000);
    // 探索は最初の委譲の開始から両方の最終返答まで（2担当の時間を合算しない）
    const exploreEnd = [std1, spc, std2].map((a) => a.receivedAt as string).sort().at(-1) as string;
    expect(sec("探索（並列）")).toMatchObject({ from: exploreStart, to: exploreEnd, seconds: (ms(exploreEnd) - ms(exploreStart)) / 1000, open: false });
    expect(sec("探索（並列）").parent.tally?.totalTokens).toBe(10000);
    expect(sec("探索（並列）").attempts).toEqual(["standards#1", "spec#1", "standards#2"]);
    expect(sec("引き渡しの検査").parent.tally).toMatchObject({ responses: 0, totalTokens: 0 });
    expect(sec("反証の検査と仕上げ")).toMatchObject({ to: fin.reportStartedAt });
    expect(sec("反証の検査と仕上げ").parent.tally?.totalTokens).toBe(100000);
    const at = (agentId: string) => u.report.attempts.find((x) => x.agentId === agentId) as Attempt;
    expect(at("StdA")).toMatchObject({ role: "standards", attempt: 1, failure: "判定と無関係な無効", seconds: (ms(std1.receivedAt as string) - ms(std1.startedAt)) / 1000 });
    expect(at("StdA").tally?.totalTokens).toBe(1000);
    expect(at("StdB")).toMatchObject({ attempt: 2, failure: null });
    expect(at("StdB").tally).toMatchObject({ totalTokens: 2000, responses: 1, outside: 1 });
    expect(at("StdB").source.path).toBe(join(agentDir, "StdB.jsonl"));
    expect(at("Spc").tally).toMatchObject({ responses: 2, turns: 1, totalTokens: 3000, maxContext: 3000, retries: { errors: [{ message: "529 overloaded" }] } });
    expect(at("Spc").tally?.retries.credentialPins).toHaveLength(2);
    expect(at("Ref").tally).toBeNull();
    expect(at("Ref").unavailable).toContain("無い");

    // (2) 保存後の確定値: 報告 Document の保存と照合の完了まで（保存の後の作業ログの応答は入れない）
    expect(u.final).toMatchObject({ from: t0, to: fin.savedAt });
    expect(u.final.parent.tally?.totalTokens).toBe(111000 + 2000000);
    // (3) MIN-33 の前後比較用: スキルの読み込みから報告の保存まで
    expect(u.comparison).toMatchObject({ from: skillAt, to: fin.savedAt });
    expect(u.comparison.parent.tally?.totalTokens).toBe(10 + 100 + 111000 + 2000000);
    expect(u.comparison.agentsTotal).toBeNull();

    // 報告には報告直前までの値だけを載せ、確定値を書き戻さない。確定値は保存後の作業ログに書く
    const report = read(join(W, "parent/report.md"));
    expect(report).toContain("## 計測");
    expect(report).toContain(t0);
    expect(report).toContain(fin.reportStartedAt);
    expect(report).not.toContain(fin.savedAt);
    expect(report).not.toContain("2111000");
    const audit = read(join(W, "parent/audit.md"));
    for (const v of ["StdA", "StdB", "Spc", "529 overloaded", parentFile, "取得できず"]) expect(audit).toContain(v);
    const shown = (await nod.run(["--json", "issue", "show", issue], repo)).json as { activity: { id?: number; body?: string }[] };
    const summary = shown.activity.find((x) => x.id === fin.logs.summary)?.body ?? "";
    expect(summary).toContain("2111000");
    expect(summary).toContain(fin.savedAt);
    expect(summary).not.toContain("成功");
    // 段階の記録（finalize 自身も終了後に残る）
    const st = stages();
    expect(st.map((x) => x.subcommand)).toContain("check-refute");
    expect(st.at(-1)).toMatchObject({ subcommand: "finalize" });
    for (const x of st) expect(ms(x.endedAt as string) >= ms(x.startedAt)).toBe(true);
    expect(read(join(W, "parent/stages.md"))).toContain("finalize");
  });

  test("評価用の事例: セッション記録の場所が無ければ使用量を取得できずとして残し（0 にしない）、区間の時間は同じく記録する", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s, "case-usage");
    await reachRefute(s, p, refuteVerdict(p, { acceptance: false }));
    expect((await runReview<{ valid: boolean }>("check-refute", ["--work", p.W], s)).json?.valid).toBe(true);
    const f = await runReview<{ status: string; usage: { record: string } }>("finalize", ["--work", p.W, "--auto-check-rows", "block"], s);
    expect(f.exitCode).toBe(0);
    expect(f.json?.status).toBe("完了");
    const u = JSON.parse(read(join(p.W, "parent/usage.json"))) as UsageRecord;
    expect(u.report.parent.tally).toBeNull();
    expect(u.report.parent.unavailable).toContain("PI_SESSION_FILE");
    expect(u.final.parent.tally).toBeNull();
    expect(u.comparison.from).toBeNull();
    expect(u.comparison.seconds).toBeNull();
    for (const a of u.report.attempts) expect(a.tally).toBeNull();
    expect(u.report.sections.map((x) => x.name)).toEqual(["準備", "探索（並列）", "引き渡しの検査", "反証", "反証の検査と仕上げ"]);
    expect(u.report.sections.every((x) => x.seconds >= 0)).toBe(true);
    const report = read(join(p.W, "parent/report.md"));
    expect(report).toContain("## 計測");
    expect(report).toContain("取得できず");
    expect(existsSync(join(p.W, "parent/usage.md"))).toBe(true);
  });
});
