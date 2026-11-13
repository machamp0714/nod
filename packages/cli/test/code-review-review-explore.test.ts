import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  anyFileContains,
  candidateBlock,
  exploreHandoff,
  filesUnder,
  gitOut,
  type PreparedWork,
  prepareCaseWork,
  put,
  runReview,
  type Sandbox,
  sandbox,
  sha256,
  shellFingerprint,
} from "./code-review-review-helpers";

// 同じ段階の境目で確かめ直した結果（共通入力・依存の写し・限定 clone、反証・受け入れ確認ではその入力の写し）
interface Identity {
  stage: string;
  ok: boolean;
  items: { name: string; ok: boolean; detail: string }[];
}

interface Agent {
  ok: boolean;
  role: string;
  roleName: string;
  definition: string;
  attempt: number;
  agentId: string | null;
  startedAt: string;
  receivedAt: string | null;
}

interface CheckExplore {
  ok: boolean;
  stage: string;
  role: string;
  attempt: number;
  agentId: string | null;
  valid: boolean;
  file: string;
  sha256: string | null;
  violations: { no: number; message: string }[];
  identity: Identity;
  files: { path: string; sha256: string }[];
}

interface Retire {
  ok: boolean;
  role: string;
  attempt: number;
  agentId: string | null;
  failure: string;
  reason: string;
  retries: string;
  movedTo: string;
  files: { path: string; sha256: string }[];
  identity: Identity;
  redelegate: boolean;
  status: string | null;
  finalReason: string | null;
}

interface RefuteInput {
  ok: boolean;
  ready: boolean;
  status: string;
  reason: string | null;
  files: { path: string; sha256: string }[];
  identity: Identity;
}

const read = (path: string) => readFileSync(path, "utf8");
const UNFIXED = "反証への入力を固定できず、反証の有効な結果なし";

function steps(s: Sandbox, p: PreparedWork) {
  const W = p.W;
  return {
    start: (role: string, id?: string) => runReview<Agent>("agent", ["--work", W, "--role", role, "--event", "start", ...(id ? ["--agent-id", id] : [])], s),
    received: (role: string, id: string) => runReview<Agent>("agent", ["--work", W, "--role", role, "--event", "received", "--agent-id", id], s),
    check: (role: string) => runReview<CheckExplore>("check-explore", ["--work", W, "--role", role], s),
    retire: (role: string, failure: string, reason: string, retries?: string) =>
      runReview<Retire>("retire-attempt", ["--work", W, "--role", role, "--failure", failure, "--reason", reason, ...(retries ? ["--retries", retries] : [])], s),
    refuteInput: () => runReview<RefuteInput>("refute-input", ["--work", W], s),
    // 委譲の開始と最終返答の受領を記録し、担当が書いたことにする引き渡し用ファイルを置く
    async delegate(role: "standards" | "spec", id: string, handoff: string, notes = "メモ\n") {
      expect((await this.start(role)).exitCode).toBe(0);
      put(join(W, role, "handoff.md"), handoff);
      put(join(W, role, "notes/memo.md"), notes);
      expect((await this.received(role, id)).exitCode).toBe(0);
    },
  };
}

const messages = (r: CheckExplore | undefined, no: number) =>
  (r?.violations ?? [])
    .filter((v) => v.no === no)
    .map((v) => v.message)
    .join("\n");

describe("code-review の探索の検査と反証への引き渡し（review.ts agent・check-explore・retire-attempt・refute-input）", () => {
  test("合格した両探索の引き渡しと共通入力だけを、原文のまま反証への入力へ写して指紋を照合する", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    const std = exploreHandoff("standards", p);
    const spc = exploreHandoff("spec", p);
    const NOTES = "NOTES-MARK-5e1f";
    await x.delegate("standards", "agent-std-1", std, NOTES);
    await x.delegate("spec", "agent-spc-1", spc, NOTES);

    const cs = await x.check("standards");
    expect(cs.stderr).toBe("");
    expect(cs.exitCode).toBe(0);
    expect(cs.json).toMatchObject({ ok: true, stage: "explore", role: "standards", attempt: 1, agentId: "agent-std-1", valid: true, violations: [], file: "standards/handoff.md", sha256: sha256(std) });
    expect(cs.json?.identity.ok).toBe(true);
    // セル内のコードや文字列の | だけでは対応表の形式違反にしない
    const cp = await x.check("spec");
    expect(cp.json).toMatchObject({ valid: true, violations: [], sha256: sha256(spc), agentId: "agent-spc-1" });
    expect(JSON.parse(read(join(p.W, "parent/check-explore.json")))).toEqual(cp.json);
    const checks = read(join(p.W, "parent/checks.md"));
    for (const h of [sha256(std), sha256(spc), sha256(NOTES)]) expect(checks).toContain(h);

    const ri = await x.refuteInput();
    expect(ri.stderr).toBe("");
    expect(ri.exitCode).toBe(0);
    expect(ri.json).toMatchObject({ ok: true, ready: true, status: "準備完了", reason: null });
    const dest = join(p.W, "refute-input");
    expect(filesUnder(dest)).toEqual(
      ["deps-files.sha256", "manifest.md", "requirements/issue.md", "requirements/workspace-rules.md", "spec-handoff.md", "standards-handoff.md", "target.md"].sort(),
    );
    // 一字も違わない写し。探索の notes/ は写さない
    expect(read(join(dest, "standards-handoff.md"))).toBe(std);
    expect(read(join(dest, "spec-handoff.md"))).toBe(spc);
    for (const f of filesUnder(join(p.W, "input"))) expect(readFileSync(join(dest, f)).equals(readFileSync(join(p.W, "input", f)))).toBe(true);
    expect(anyFileContains(dest, NOTES)).toEqual([]);
    expect(read(join(p.W, "parent/fingerprints.md"))).toContain(shellFingerprint(dest));
    expect(ri.json?.files).toHaveLength(7);

    // 委譲の記録（役割・定義名・試行・担当 ID・開始と受領の時刻）
    const agents = JSON.parse(read(join(p.W, "parent/agents.json"))) as Agent[];
    expect(agents.map((a) => [a.role, a.definition, a.attempt, a.agentId])).toEqual([
      ["standards", "code-reviewer-standards", 1, "agent-std-1"],
      ["spec", "code-reviewer-spec", 1, "agent-spc-1"],
    ]);
    for (const a of agents) expect(Date.parse(a.receivedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(a.startedAt));
    const agentsMd = read(join(p.W, "parent/agents.md"));
    expect(agentsMd).toContain("| Standards 探索 | code-reviewer-standards | 1 | agent-std-1 |");
    expect(agentsMd).toContain(agents[1]?.receivedAt ?? "-");

    // 反証は写しの後に起動できる。反証の同一入力の確認は refute-input/ の写しも比べる
    expect((await x.start("refute", "agent-ref-1")).json).toMatchObject({ role: "refute", attempt: 1, definition: "code-reviewer-refute" });
    put(join(dest, "target.md"), "書き換えた\n");
    const rr = await x.retire("refute", "invalid", "7節の1: 担当が失敗を返した");
    expect(rr.json).toMatchObject({ redelegate: false, status: "未完了", finalReason: "有効な結果なし（反証。同じ入力を固定できず委譲し直さなかった）" });
    expect(rr.json?.identity.items.filter((i) => !i.ok).map((i) => i.name).join("\n")).toContain("refute-input");
  });

  test("候補 ID: 接頭辞の違反・重複・対応表が参照する無い ID・候補 ID の無い未充足の行を形式違反にする", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    await x.delegate("standards", "a1", exploreHandoff("standards", p, { candidates: [candidateBlock("STD-1"), candidateBlock("STD-1"), candidateBlock("SPC-2")] }));
    const table = [
      "| `requirements/issue.md:L1-L3` | 未確認 | 確かめられない | SPC-9 |",
      "| `requirements/issue.md:L4` | 未充足 | 記録しない | なし |",
      "| `requirements/workspace-rules.md:L1-L3` | 対象外 | 関係しない | なし |",
    ];
    await x.delegate("spec", "a2", exploreHandoff("spec", p, { table }));

    const cs = await x.check("standards");
    expect(cs.json?.valid).toBe(false);
    expect(messages(cs.json, 4)).toContain("STD-1");
    expect(messages(cs.json, 4)).toContain("SPC-2");
    const cp = await x.check("spec");
    expect(cp.json?.valid).toBe(false);
    expect(messages(cp.json, 6)).toContain("SPC-9");
    expect(messages(cp.json, 6)).toContain("requirements/issue.md:L4");
    expect(read(join(p.W, "parent/checks.md"))).toContain("不合格");
    // 合格していない探索は写さない
    const ri = await x.refuteInput();
    expect(ri.exitCode).toBe(2);
    expect(readdirSync(join(p.W, "refute-input"))).toEqual([]);
  });

  test("出典の欠落と形式違反（必須節・必須項目・語彙外の状態・対象版・定義名・禁止項目の見出しと項目名）を検出する", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    const table = ["| `requirements/issue.md:L1-L2` | 説明 | 見出し | なし |", "| `requirements/issue.md:L3-L4` | 済み | 確かめた | なし |"];
    const spc = exploreHandoff("spec", p, { table, candidates: [candidateBlock("SPC-1", { 軸: "Spec", 破綻: null, 確信度: "高" })] })
      .replace(`head \`${p.head}\``, `head \`${"f".repeat(40)}\``)
      .replace("## 判断を見送った事項\n\nなし\n", "## 要約\n\n短くまとめた\n");
    await x.delegate("spec", "a2", spc);
    const std = exploreHandoff("standards", p, { candidates: [candidateBlock("STD-1", { 証拠: "証拠を取得できなかった" })] }).replace(
      "定義名: code-reviewer-standards",
      "定義名: code-reviewer",
    );
    await x.delegate("standards", "a1", std);

    const cp = await x.check("spec");
    expect(cp.json?.valid).toBe(false);
    expect(messages(cp.json, 6)).toContain("requirements/workspace-rules.md");
    expect(messages(cp.json, 6)).toContain("済み");
    expect(messages(cp.json, 3)).toContain("判断を見送った事項");
    expect(messages(cp.json, 3)).toContain("対象版");
    expect(messages(cp.json, 4)).toContain("破綻");
    expect(messages(cp.json, 7)).toContain("要約");
    expect(messages(cp.json, 7)).toContain("確信度");
    expect(cp.json?.identity.ok).toBe(true);

    const cs = await x.check("standards");
    expect(cs.json?.valid).toBe(false);
    expect(messages(cs.json, 3)).toContain("定義名");
    expect(messages(cs.json, 4)).toContain("不足箇所");
  });

  test("指紋の不一致: 担当が input/・deps/・限定 clone を変えたら検査に通らず、検査の後に引き渡しが変われば反証を起動しない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    const std = exploreHandoff("standards", p);
    await x.delegate("standards", "a1", std);
    await x.delegate("spec", "a2", exploreHandoff("spec", p));
    const issue = join(p.W, "input/requirements/issue.md");
    const dep = join(p.W, "deps/node_modules/left-pad/index.js");
    const issueBody = read(issue);
    const depBody = read(dep);
    const mutations: { name: string; apply: () => void; restore: () => void; item: string }[] = [
      { name: "input", apply: () => put(issue, `${issueBody}追記\n`), restore: () => put(issue, issueBody), item: "共通入力" },
      { name: "deps", apply: () => put(dep, "changed\n"), restore: () => put(dep, depBody), item: "依存の写し" },
      {
        name: "clone",
        apply: () => gitOut(p.clone, "update-ref", "refs/heads/extra", "HEAD"),
        restore: () => gitOut(p.clone, "update-ref", "-d", "refs/heads/extra"),
        item: "限定 clone",
      },
    ];
    for (const m of mutations) {
      m.apply();
      const bad = await x.check("standards");
      expect({ name: m.name, valid: bad.json?.valid, identity: bad.json?.identity.ok }).toEqual({ name: m.name, valid: false, identity: false });
      expect(messages(bad.json, 8)).toContain(m.item);
      m.restore();
      expect((await x.check("standards")).json?.valid).toBe(true);
    }
    expect((await x.check("spec")).json?.valid).toBe(true);

    // 検査の後に引き渡しが変わった: 写しが検査時の指紋と一致せず、反証を起動できない
    put(join(p.W, "standards/handoff.md"), `${std}追記\n`);
    const ri = await x.refuteInput();
    expect(ri.exitCode).toBe(0);
    expect(ri.json).toMatchObject({ ready: false, status: "未完了", reason: UNFIXED });
    expect(read(join(p.W, "parent/fingerprints.md"))).toContain("不一致");
    expect((await x.start("refute")).exitCode).toBe(2);
  });

  test("無効な試行の原出力を隔離して記録し、委譲し直した試行だけを反証へ渡す", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    const MARK = "ATTEMPT1-MARK-77aa";
    const bad = exploreHandoff("standards", p).replace("## 判断を見送った事項", `## 総合判断\n\n${MARK}\n\n## 判断を見送った事項`);
    await x.delegate("standards", "agent-std-1", bad, `${MARK} メモ\n`);
    await x.delegate("spec", "agent-spc-1", exploreHandoff("spec", p));
    expect(messages((await x.check("standards")).json, 7)).toContain("総合判断");

    const r = await x.retire("standards", "invalid", "5節の7: 禁止項目の見出し「総合判断」");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const moved = join(p.W, "parent/attempts/standards-1");
    expect(r.json).toMatchObject({ role: "standards", attempt: 1, agentId: "agent-std-1", redelegate: true, status: null, finalReason: null, retries: "記録なし", movedTo: moved });
    expect(r.json?.identity.ok).toBe(true);
    expect(read(join(moved, "handoff.md"))).toBe(bad);
    expect(r.json?.files).toEqual([
      { path: "handoff.md", sha256: sha256(bad) },
      { path: "notes/memo.md", sha256: sha256(`${MARK} メモ\n`) },
    ]);
    expect(readdirSync(join(p.W, "standards"))).toEqual(["notes"]);
    expect(readdirSync(join(p.W, "standards/notes"))).toEqual([]);
    const attempts = read(join(p.W, "parent/attempts.md"));
    for (const v of ["Standards 探索", "code-reviewer-standards", "agent-std-1", "禁止項目の見出し「総合判断」", "記録なし", sha256(bad)]) expect(attempts).toContain(v);
    // 隔離した試行は検査し直せない
    expect((await x.retire("standards", "invalid", "重ねて")).exitCode).toBe(2);

    const again = await x.start("standards");
    expect(again.json).toMatchObject({ attempt: 2 });
    const good = exploreHandoff("standards", p);
    put(join(p.W, "standards/handoff.md"), good);
    expect((await x.received("standards", "agent-std-2")).json).toMatchObject({ attempt: 2, agentId: "agent-std-2" });
    expect((await x.check("standards")).json).toMatchObject({ attempt: 2, valid: true });
    expect((await x.check("spec")).json?.valid).toBe(true);

    const ri = await x.refuteInput();
    expect(ri.json?.ready).toBe(true);
    expect(read(join(p.W, "refute-input/standards-handoff.md"))).toBe(good);
    expect(anyFileContains(join(p.W, "refute-input"), MARK)).toEqual([]);
    const agentsMd = read(join(p.W, "parent/agents.md"));
    expect(agentsMd).toContain("| Standards 探索 | code-reviewer-standards | 1 | agent-std-1 |");
    expect(agentsMd).toContain("| Standards 探索 | code-reviewer-standards | 2 | agent-std-2 |");
  });

  test("再委譲の可否: 2回目の無効と同じ入力でない場合は委譲し直さず、未完了の理由を決める", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    await x.delegate("standards", "s1", exploreHandoff("standards", p));
    await x.delegate("spec", "p1", exploreHandoff("spec", p));
    expect((await x.retire("standards", "invalid", "終了通知: failed")).json?.redelegate).toBe(true);
    await x.delegate("standards", "s2", "壊れた出力\n");
    const second = await x.retire("standards", "invalid", "5節の3: 必須節が無い");
    expect(second.json).toMatchObject({ attempt: 2, redelegate: false, status: "未完了", finalReason: "有効な結果なし（Standards 探索。1回の再委譲の後も）" });
    expect(existsSync(join(p.W, "parent/attempts/standards-2/handoff.md"))).toBe(true);
    expect((await x.start("standards")).exitCode).toBe(2);

    put(join(p.W, "input/requirements/issue.md"), "担当が書き換えた\n");
    const changed = await x.retire("spec", "invalid", "5節の8: 共通入力の不一致");
    expect(changed.json).toMatchObject({ attempt: 1, redelegate: false, status: "未完了", finalReason: "有効な結果なし（Spec 探索。同じ入力を固定できず委譲し直さなかった）" });
    expect(changed.json?.identity.ok).toBe(false);
    expect((await x.start("spec")).exitCode).toBe(2);
  });

  test("再委譲の可否: 利用枠の上限と利用者による中止は委譲し直さず、以後どの担当も起動しない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s, "limit");
    const x = steps(s, p);
    await x.delegate("standards", "s1", "");
    expect((await x.start("spec", "p1")).exitCode).toBe(0);
    const limit = await x.retire("standards", "usage-limit", "HTTP 429 usage_limit_reached", "omp の retry 3回（429 rate_limit_error）");
    expect(limit.json).toMatchObject({ redelegate: false, status: "未完了", finalReason: "利用枠の上限、有効な結果なし（Standards 探索）", retries: "omp の retry 3回（429 rate_limit_error）" });
    expect(read(join(p.W, "parent/attempts.md"))).toContain("omp の retry 3回（429 rate_limit_error）");
    // 並列で実行中だった担当の受領は記録できるが、委譲し直しも新しい起動もしない
    expect((await x.received("spec", "p1")).exitCode).toBe(0);
    expect((await x.retire("spec", "invalid", "5節の2: handoff.md が無い")).json).toMatchObject({ redelegate: false, status: "未完了" });
    expect((await x.start("standards")).exitCode).toBe(2);
    expect((await x.start("refute")).exitCode).toBe(2);

    const s2 = sandbox();
    const q = await prepareCaseWork(s2, "abort");
    const y = steps(s2, q);
    await y.delegate("spec", "p1", "");
    expect((await y.retire("spec", "aborted", "利用者が止めた")).json).toMatchObject({ redelegate: false, status: "未完了", finalReason: "利用者による中止" });
    expect((await y.start("spec")).exitCode).toBe(2);
    expect((await y.start("standards")).exitCode).toBe(2);
  });

  test("引数の誤りは終了コード 2 で、記録を変えない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const x = steps(s, p);
    const runs = [
      await runReview<CheckExplore>("check-explore", ["--work", p.W, "--role", "refute"], s),
      await x.check("standards"),
      await runReview<Agent>("agent", ["--work", p.W, "--role", "spec", "--event", "finished"], s),
      await x.received("spec", "p1"),
      await x.retire("spec", "invalid", "まだ委譲していない"),
      await runReview<Retire>("retire-attempt", ["--work", p.W, "--role", "spec", "--failure", "timeout", "--reason", "x"], s),
      await runReview<RefuteInput>("refute-input", ["--work", "relative/path"], s),
      await runReview<RefuteInput>("refute-input", ["--work", join(s.t, "no-such-work")], s),
      await x.refuteInput(),
    ];
    for (const r of runs) expect({ exitCode: r.exitCode, code: (r.json as { code?: string } | undefined)?.code }).toEqual({ exitCode: 2, code: "INVALID_INPUT" });
    expect(existsSync(join(p.W, "parent/agents.json"))).toBe(false);
    expect(readdirSync(join(p.W, "refute-input"))).toEqual([]);
  });
});
