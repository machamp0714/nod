import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEPTANCE_ROW,
  anyFileContains,
  commit,
  filesUnder,
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
  shellFingerprint,
  type TempNod,
  tempNod,
} from "./code-review-review-helpers";

interface Identity {
  stage: string;
  ok: boolean;
  items: { name: string; ok: boolean; detail: string }[];
}

interface CheckRefute {
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
  acceptanceRows: number | null;
  acceptanceRequired: boolean | null;
}

// check-refute が親専用領域に残す反証の判定本文の構造（後の段階が点数・確認が残る事項を算出する）
interface Structure {
  attempt: number;
  sha256: string;
  axes: Record<string, { required: number; unconfirmed: number }>;
  decisions: { id: string; finder: string; verdict: string; impact: number | null; cause: string | null; reason: string }[];
  required: { heading: string; title: string; ids: string[]; impact: number | null; axis: string | null; location: string; effect: string }[];
  table: { source: string; status: string; evidence: string; candidates: string[]; splitFrom: string | null; added: boolean }[];
  unconfirmed: { ref: string; axis: string; kind: string; reason: string; owner: string; missing: string }[];
  acceptanceRows: { source: string; artifacts: string; work: string; canon: string; candidates: string[] }[];
  acceptanceRequired: boolean;
}

interface Ref {
  type: string;
  source: string;
  kind: string;
  from: string;
  at: string;
  quote: string;
  version?: string;
  revision?: string;
  path?: string;
  history?: boolean;
}

interface Item {
  id: string;
  kind: string;
  from: string;
  source: string;
  method: string;
  identity: string;
  versionMatch: string;
  quote: string;
  obtained: boolean;
  code: string;
  status: string;
  copies: { path: string; sha256: string }[];
  originals: { path: string; sha256: string }[];
}

interface AcceptanceInput {
  ok: boolean;
  ready: boolean;
  status: string;
  reason: string | null;
  files: { path: string; sha256: string }[];
  identity: Identity;
}

const read = (path: string) => readFileSync(path, "utf8");
const REMOVED = "（CI の結果は親だけが扱うため除いた）";
const UNFIXED = "受け入れ確認への入力を固定できず、受け入れ確認の有効な結果なし";

const checkRefute = (s: Sandbox, p: PreparedWork) => runReview<CheckRefute>("check-refute", ["--work", p.W], s);
const messages = (r: CheckRefute | undefined, no: number) =>
  (r?.violations ?? [])
    .filter((v) => v.no === no)
    .map((v) => v.message)
    .join("\n");

// 記録の各行（目録の表の1行のセル）
function rowOf(md: string, id: string): string[] | undefined {
  const line = md.split("\n").find((l) => l.startsWith(`| \`${id}\` |`));
  return line
    ?.slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// 偽の curl（ネットワークを使わない）。引数を log に残し、-D と -o の先に見出しと本文を書く
function fakeCurl(s: Sandbox): () => string[] {
  const log = join(s.t, "curl.log");
  const path = join(s.bin, "curl");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${log}"`,
      'while [ $# -gt 0 ]; do case "$1" in -D) D="$2"; shift;; -o) O="$2"; shift;; *) last="$1";; esac; shift; done',
      `printf 'HTTP/2 200\\r\\netag: "e1"\\r\\n\\r\\n' > "$D"`,
      "printf 'ページの本文\\n<!-- ci-result:begin -->\\nCI-IN-URL\\n<!-- ci-result:end -->\\n' > \"$O\"",
      "printf '200 %s\\n' \"$last\"",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return () => (existsSync(log) ? read(log).trimEnd().split("\n") : []);
}

// 呼ばれたら記録して失敗する偽の nod（評価用の事例で nod を使わないことを確かめる）
function forbiddenNod(s: Sandbox): () => string {
  const log = join(s.t, "nod.log");
  const path = join(s.bin, "fake-nod");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 9\n`);
  chmodSync(path, 0o755);
  s.env.NOD_CLI = path;
  return () => (existsSync(log) ? read(log) : "");
}

// Issue の有無を選べる、nod の一時 DB を使う準備（要求は Issue 本文か無しと、Workspace の規約）
async function prepareNodWork(s: Sandbox, repo: string, base: string, head: string, issue: string | null, name: string): Promise<PreparedWork> {
  const W = join(s.t, "work", name);
  const r = await runReview<{ ready: boolean }>("prepare", ["--work", W, "--repo", repo, "--mode", "commit", "--base", base, "--head", head, ...(issue ? ["--issue", issue] : [])], s);
  if (r.exitCode !== 0 || !r.json?.ready) throw new Error(`prepare が準備完了を返しません: ${r.stdout}${r.stderr}`);
  return { W, repo, base, head, clone: join(W, "repo") };
}

async function nodRepo(s: Sandbox): Promise<{ nod: TempNod; repo: string; base: string; head: string }> {
  const nod = tempNod(s);
  const repo = makeGitRepo(s, "app");
  registerRepo(nod.db, repo, "APP");
  const base = gitOut(repo, "rev-parse", "HEAD");
  const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
  expect((await nod.run(["workspace", "rules", "set", "--text", "# 規約\n\n- 日本語で書く"], repo)).exitCode).toBe(0);
  return { nod, repo, base, head };
}

const items = (p: PreparedWork) => JSON.parse(read(join(p.W, "parent/acceptance/items.json"))) as Item[];

describe("code-review の反証の検査と受け入れ確認への入力（review.ts check-refute・acceptance-records・acceptance-input）", () => {
  test("反証の判定本文を機械検査し、読み取った構造を親専用領域に残して、受け入れ確認担当の行を rows.md に抽出する", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p);
    await reachRefute(s, p, verdict);

    const r = await checkRefute(s, p);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      stage: "refute",
      role: "refute",
      attempt: 1,
      agentId: "agent-refute",
      valid: true,
      violations: [],
      file: "refute/verdict.md",
      sha256: sha256(verdict),
      acceptanceRows: 1,
      acceptanceRequired: true,
    });
    expect(r.json?.identity.ok).toBe(true);
    expect(r.json?.identity.items.map((i) => i.name).join("\n")).toContain("refute-input/");
    // 判定本文を書き換えない
    expect(read(join(p.W, "refute/verdict.md"))).toBe(verdict);
    expect(JSON.parse(read(join(p.W, "parent/check-refute.json")))).toEqual(r.json);
    expect(read(join(p.W, "parent/checks.md"))).toContain(sha256(verdict));

    const st = JSON.parse(read(join(p.W, "parent/refute-structure.json"))) as Structure;
    expect(st).toMatchObject({ attempt: 1, sha256: sha256(verdict), acceptanceRequired: true });
    expect(st.axes).toEqual({ Standards: { required: 1, unconfirmed: 0 }, Spec: { required: 0, unconfirmed: 2 } });
    expect(st.decisions.map((d) => [d.id, d.finder, d.verdict, d.impact, d.cause])).toEqual([
      ["STD-1", "Standards 探索", "要対応", 3, "CAUSE-1"],
      ["SPC-1", "Spec 探索", "未確認", null, null],
      ["REF-1", "反証で追加", "要対応", 2, "CAUSE-1"],
    ]);
    expect(st.required).toEqual([{ heading: "CAUSE-1", title: "集計が誤る", ids: ["STD-1", "REF-1"], impact: 2, axis: "Standards", location: "src/a.ts@HEAD:L1", effect: "集計が誤る" }]);
    expect(st.table.map((t) => [t.source, t.status, t.candidates, t.splitFrom, t.added])).toEqual([
      ["requirements/issue.md:L1", "説明", [], null, false],
      ["requirements/issue.md:L3（コードの部分）", "充足", [], "requirements/issue.md:L3", false],
      ["requirements/issue.md:L3（記録の部分）", "受け入れ確認担当", ["SPC-1"], "requirements/issue.md:L3", false],
      ["requirements/issue.md:L4", "充足", [], null, false],
      ["requirements/workspace-rules.md:L1-L3", "対象外", [], null, false],
      ["requirements/issue.md:L2", "未確認", [], null, true],
    ]);
    // セル内のコードの | は区切りにしない
    expect(st.table[1]?.evidence).toBe("src/a.ts@HEAD:L1 の a | b");
    expect(st.unconfirmed).toEqual([
      { ref: "SPC-1", axis: "Spec", kind: "候補", reason: "受け入れ確認担当の行で確かめる", owner: "受け入れ確認担当", missing: "失敗の作業記録" },
      { ref: "requirements/issue.md:L2", axis: "Spec", kind: "要求", reason: "要実行確認", owner: "人", missing: "実行しないと分からない挙動" },
    ]);
    expect(st.acceptanceRows).toMatchObject([{ source: "requirements/issue.md:L3（記録の部分）", artifacts: "失敗の記録", work: "記録した作業", canon: "なし", candidates: ["SPC-1"] }]);

    const rows = read(join(p.W, "parent/acceptance/rows.md"));
    expect(rows).toContain("requirements/issue.md:L3（記録の部分）");
    expect(rows).toContain("件数: 1");
    expect(rows).toContain("必要な担当");

    // 受け入れ確認は、受け入れ確認への入力が準備完了になるまで起動しない
    const start = await runReview("agent", ["--work", p.W, "--role", "acceptance", "--event", "start"], s);
    expect(start.exitCode).toBe(2);
    expect(read(join(p.W, "parent/agents.md"))).not.toContain("受け入れ確認");
  });

  test("受け入れ確認担当の行が0行なら起動不要とし、受け入れ確認への入力を作らない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    await reachRefute(s, p, refuteVerdict(p, { acceptance: false }));
    const r = await checkRefute(s, p);
    expect(r.json).toMatchObject({ valid: true, violations: [], acceptanceRows: 0, acceptanceRequired: false });
    const st = JSON.parse(read(join(p.W, "parent/refute-structure.json"))) as Structure;
    expect(st.acceptanceRows).toEqual([]);
    expect(st.axes.Spec).toEqual({ required: 0, unconfirmed: 3 });
    expect(read(join(p.W, "parent/acceptance/rows.md"))).toContain("受け入れ確認担当の行なし（起動せず）");

    const rec = await runReview("acceptance-records", ["--work", p.W], s);
    expect(rec.exitCode).toBe(2);
    expect(existsSync(join(p.W, "acceptance-input"))).toBe(false);
  });

  test("形式違反（分割元の出典の欠落・Spec の行の確定漏れ・軸ごとの集計の不一致・採否一覧の候補漏れ・影響度の欠落・同一候補の判定の不一致・担当行の節の不一致・未確認の表の欠落）を無効にする", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    await reachRefute(s, p, v);
    const L2_UNCONFIRMED = "| `requirements/issue.md:L2` | Spec | 要求 | 要実行確認 | 人 | 実行しないと分からない挙動 |\n";
    const cases: [string, string, number, string][] = [
      ["分割元の出典の欠落", v.replace(`| ${ACCEPTANCE_ROW} | \`requirements/issue.md:L3\` |\n`, ""), 4, "requirements/issue.md:L3（記録の部分）"],
      ["分割元が Spec 探索の行に無い", v.replace("| `requirements/issue.md:L3`（コードの部分） | `requirements/issue.md:L3` |", "| `requirements/issue.md:L3`（コードの部分） | `requirements/issue.md:L9` |"), 4, "requirements/issue.md:L9"],
      ["Spec 探索の行の確定漏れ", v.replace("| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` | なし |\n", ""), 4, "requirements/issue.md:L4"],
      ["軸ごとの要対応の件数の不一致", v.replace("- Standards: 要対応 1 件", "- Standards: 要対応 2 件"), 5, "Standards"],
      ["軸ごとの未確認の件数の不一致", v.replace("- Spec: 要対応 0 件、未確認 2 件", "- Spec: 要対応 0 件、未確認 1 件"), 5, "Spec"],
      ["採否一覧の候補漏れ", v.replace("| SPC-1 | Spec 探索 | 未確認 | なし | なし | 受け入れ確認担当の行で確かめる |\n", ""), 3, "SPC-1"],
      ["反証で追加した発見の採否漏れ", v.replace("| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 | 固定版で確かめた |\n", ""), 3, "REF-1"],
      ["要対応の影響度の欠落", v.replace("| STD-1 | Standards 探索 | 要対応 | 3 |", "| STD-1 | Standards 探索 | 要対応 |  |"), 3, "STD-1"],
      ["同一候補の判定の不一致", v.replace("| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 |", "| REF-1 | 反証で追加 | 棄却 | なし | なし |"), 3, "REF-1"],
      ["同一原因の影響度が集約と違う", v.replace("- 影響度: 2", "- 影響度: 3"), 3, "CAUSE-1"],
      [
        "受け入れ確認担当の行の節と対応表の不一致",
        v.replace(`| ${ACCEPTANCE_ROW} | 失敗の記録 | 記録した作業 | なし |`, `| ${ACCEPTANCE_ROW} | 失敗の記録 | 記録した作業 | なし |\n| \`requirements/issue.md:L4\` | 配置 | 配置した作業 | なし |`),
        6,
        "requirements/issue.md:L4",
      ],
      ["未確認と理由が自由記述", v.replace(/## 未確認と理由\n[\s\S]*?\n## 判断を見送った事項/, "## 未確認と理由\n\nSPC-1 は作業記録が無いので未確認。\n\n## 判断を見送った事項"), 5, "未確認と理由"],
      ["未確認の行が未確認の表に無い", v.replace(L2_UNCONFIRMED, "").replace("未確認 2 件", "未確認 1 件"), 5, "requirements/issue.md:L2"],
    ];
    for (const [name, text, no, needle] of cases) {
      expect(text).not.toBe(v);
      put(join(p.W, "refute/verdict.md"), text);
      const r = await checkRefute(s, p);
      expect(r.exitCode).toBe(0);
      expect(`${name}: ${r.json?.valid}`).toBe(`${name}: false`);
      expect(`${name}: ${messages(r.json, no)}`).toContain(needle);
    }
    // 無効な判定本文からは構造も担当行も残さない
    expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
    expect(existsSync(join(p.W, "parent/acceptance/rows.md"))).toBe(false);
    expect((await runReview("acceptance-records", ["--work", p.W], s)).exitCode).toBe(2);

    // 無効な結果は retire-attempt で隔離し、反証だけを1回委譲し直して同じ検査をする
    const retire = await runReview<{ redelegate: boolean }>("retire-attempt", ["--work", p.W, "--role", "refute", "--failure", "invalid", "--reason", "7節の4: 分割元の出典の欠落"], s);
    expect(retire.json?.redelegate).toBe(true);
    expect((await runReview("agent", ["--work", p.W, "--role", "refute", "--event", "start"], s)).exitCode).toBe(0);
    put(join(p.W, "refute/verdict.md"), v);
    expect((await runReview("agent", ["--work", p.W, "--role", "refute", "--event", "received", "--agent-id", "agent-refute-2"], s)).exitCode).toBe(0);
    const ok = await checkRefute(s, p);
    expect(ok.json).toMatchObject({ valid: true, attempt: 2, agentId: "agent-refute-2", acceptanceRows: 1 });
  });

  test("Issue あり: Activity と全添付 Document を写して CI の結果を印で除き、明示参照の証拠を許可された方法だけで取得して、1項目1行の目録と親専用の記録を作る", async () => {
    const s = sandbox();
    const { nod, repo, base, head } = await nodRepo(s);
    // 証拠の出典
    const evDir = join(s.t, "evidence");
    const logFile = join(evDir, "run.log");
    put(logFile, "実行の記録\n<!-- ci-result:begin -->\nCI-IN-FILE\n<!-- ci-result:end -->\n終わり\n");
    const secretFile = join(evDir, ".env");
    put(secretFile, "SECRET-VALUE\n");
    const forbidden = join(s.home, ".local/share/nod/review-evaluation/inputs/x/evidence.md");
    put(forbidden, "評価用\n");
    const missing = join(evDir, "none.txt");
    const design = makeGitRepo(s, "design");
    const v1 = commit(design, { "design.md": "デザイン v1\n" }, "v1");
    git(design, "tag", "v1");
    const v2 = commit(design, { "design.md": "デザイン v2\n" }, "v2");
    put(join(design, "design.md"), "WORKTREE-ONLY\n");
    const designRefs = gitOut(design, "for-each-ref");
    const designStatus = gitOut(design, "status", "--porcelain");
    const curlLog = fakeCurl(s);

    // Issue・Activity（実際の nod の返信）・添付 Document・リンクされていない Document
    const id = (await nod.run(["--json", "issue", "create", "要求の Issue", "--description", "本文"], repo)).json.id as string;
    const free = (await nod.run(["--json", "doc", "create", "free.md", "--title", "外部の記録", "--body", "外部の記録\n<!-- ci-result:begin -->\nCI-IN-UNLINKED\n<!-- ci-result:end -->\n"], repo)).json;
    const note = (
      await nod.run(["--json", "doc", "create", "note.md", "--title", "メモ", "--kind", "doc", "--issue", id, "--body", `メモ: Document ${free.id} を参照\n<!-- ci-result:begin -->\nCI-IN-LINKED\n<!-- ci-result:end -->\n`], repo)
    ).json;
    // nod doc create は見出しを付けるので、本文が [ci-result] で始まる Document はファイルを書き換えて作る
    const ciDoc = (await nod.run(["--json", "doc", "create", "ci.md", "--title", "CI", "--kind", "doc", "--issue", id], repo)).json;
    put(ciDoc.path, "[ci-result] CI-IN-WHOLE-DOC\n");
    const comment = async (body: string, replyTo?: number) => (await nod.run(["--json", "issue", "comment", id, body, ...(replyTo ? ["--reply-to", String(replyTo)] : [])], repo)).json.id as number;
    const a = await comment(`作業: ${logFile} と ${secretFile} と ${forbidden} を確認。URL http://example.com/plain と https://example.com/x?token=abc と https://user:pw@example.com/y と https://example.com/ok`);
    const r1 = await comment("[ci-result] CI-IN-REPLY", a);
    const r2 = await comment(`補足 ${missing}`, a);
    const r4 = await comment("[ci-result] CI-IN-NESTED", r2);
    const log = (await nod.run(["--json", "issue", "log", id, "[ci-result] CI-IN-LOG", "--kind", "test"], repo)).json.id as number;
    const r3 = await comment("ログへの返信 REPLY-OF-CI-LOG", log);

    const p = await prepareNodWork(s, repo, base, head, id, "issue");
    const canon = `\`design.md\`（${design} の v1）`;
    const verdict = refuteVerdict(p, { canon });
    await reachRefute(s, p, verdict);
    expect((await checkRefute(s, p)).json?.valid).toBe(true);

    const rec = await runReview<{ ok: boolean; candidates: number }>("acceptance-records", ["--work", p.W], s);
    expect(rec.stderr).toBe("");
    expect(rec.exitCode).toBe(0);
    const A = join(p.W, "acceptance-input");
    const P = join(p.W, "parent/acceptance");
    // Activity: 本文が [ci-result] で始まる作業ログ・コメントを返信ごと、残したコメントの返信（入れ子を含む）のうち [ci-result] で始まるものを除く
    const kept = read(join(A, "records/activity.json"));
    for (const mark of ["CI-IN-REPLY", "CI-IN-NESTED", "CI-IN-LOG", "REPLY-OF-CI-LOG"]) {
      expect(kept).not.toContain(mark);
      expect(read(join(P, "activity.json"))).toContain(mark);
    }
    expect(kept).toContain("補足");
    expect(kept).toContain("作業:");
    // Document: kind を問わず全件。印の間と本文全体を置き換え、元の写しを親専用領域に残す
    expect(read(join(A, `records/documents/document-${note.id}.md`))).toBe(`# メモ\n\nメモ: Document ${free.id} を参照\n<!-- ci-result:begin -->\n${REMOVED}\n<!-- ci-result:end -->\n`);
    expect(read(join(A, `records/documents/document-${ciDoc.id}.md`))).toBe(`${REMOVED}\n`);
    expect(read(join(P, `documents/document-${note.id}.md`))).toContain("CI-IN-LINKED");
    expect(read(join(P, `documents/document-${ciDoc.id}.md`))).toBe("[ci-result] CI-IN-WHOLE-DOC\n");
    // 共通入力と反証の判定本文は原文のまま
    expect(read(join(A, "refute-verdict.md"))).toBe(verdict);
    for (const f of filesUnder(join(p.W, "input"))) expect(readFileSync(join(A, f)).equals(readFileSync(join(p.W, "input", f)))).toBe(true);

    // 写しから機械的に挙げた明示参照の候補（場所付き）。Issue にリンクされた Document は records/ に写したので候補にしない
    const cands = JSON.parse(read(join(P, "ref-candidates.json"))) as Ref[];
    const listed = cands.map((c) => `${c.type} ${c.source}`);
    expect(listed).toEqual(
      expect.arrayContaining([
        `file ${logFile}`,
        `file ${secretFile}`,
        `file ${forbidden}`,
        `file ${missing}`,
        "url http://example.com/plain",
        "url https://example.com/x?token=abc",
        "url https://user:pw@example.com/y",
        "url https://example.com/ok",
        `document ${free.id}`,
        `file ${design}`,
      ]),
    );
    expect(listed).not.toContain(`document ${note.id}`);
    expect(cands.find((c) => c.source === logFile)).toMatchObject({ kind: "参照された記録", from: `activity:${a}` });
    expect(cands.find((c) => c.source === missing)?.from).toBe(`activity:${r2}`);
    expect(cands.find((c) => c.source === String(free.id))).toMatchObject({ from: `document:${note.id}`, at: `records/documents/document-${note.id}.md:L3` });
    expect(cands.find((c) => c.source === design)).toMatchObject({ kind: "外部の正本", from: "受け入れ確認担当の行 requirements/issue.md:L3（記録の部分）" });
    expect(read(join(P, "ref-candidates.md"))).toContain(logFile);

    // 親が確かめて足し引きした参照の一覧（Git は版を名指しして足す）
    const from = "受け入れ確認担当の行 requirements/issue.md:L3（記録の部分）";
    const refs: Ref[] = [
      ...cands.filter((c) => c.source !== design),
      { type: "git", source: design, revision: "v1", path: "design.md", kind: "外部の正本", from, at: "refute-verdict.md", quote: canon, version: "v1" },
      { type: "git", source: design, revision: "main", path: "design.md", history: true, kind: "外部の正本", from, at: "refute-verdict.md", quote: canon, version: "記載なし" },
      { type: "git", source: design, revision: "no-such", path: "design.md", kind: "参照された記録", from: `activity:${a}`, at: `records/activity.json の activity:${a}`, quote: "no-such" },
      { type: "file", source: "src/a.ts", kind: "参照された記録", from: `activity:${a}`, at: `records/activity.json の activity:${a}`, quote: "src/a.ts" },
    ];
    const refsFile = join(s.t, "refs.json");
    put(refsFile, JSON.stringify(refs, null, 2));
    const ai = await runReview<AcceptanceInput>("acceptance-input", ["--work", p.W, "--refs", refsFile], s);
    expect(ai.stderr).toBe("");
    expect(ai.exitCode).toBe(0);
    expect(ai.json).toMatchObject({ ok: true, ready: true, status: "準備完了", reason: null });
    expect(ai.json?.identity.ok).toBe(true);
    expect(ai.json?.files.map((f) => `${f.sha256}  ./${f.path}\n`).join("")).toBe(shellFingerprint(A));
    expect(JSON.parse(read(join(p.W, "parent/acceptance-input.json")))).toEqual(ai.json);
    expect(read(join(P, "fingerprints.md"))).toContain(shellFingerprint(A));

    const list = items(p);
    const ev = (pred: (i: Item) => boolean) => {
      const found = list.filter((i) => i.id.startsWith("evidence/") && pred(i));
      expect(found).toHaveLength(1);
      return found[0] as Item;
    };
    const dirOf = (i: Item) => i.id.slice("evidence/".length);
    // 通常のファイルは copy-evidence.ts で写し、写しから CI の結果を印で除く（観測と元の写しは親専用領域に残る）
    const file = ev((i) => i.source === logFile);
    expect(file).toMatchObject({ obtained: true, code: "COPIED", kind: "参照された記録", from: `activity:${a}` });
    expect(file.method).toContain("copy-evidence.ts");
    expect(read(join(A, "evidence", dirOf(file), "copy"))).toBe(`実行の記録\n<!-- ci-result:begin -->\n${REMOVED}\n<!-- ci-result:end -->\n終わり\n`);
    expect(read(join(P, "evidence", dirOf(file), "copy"))).toContain("CI-IN-FILE");
    const observation = readFileSync(join(P, "evidence", dirOf(file), "observation.txt"));
    expect(readFileSync(join(A, "evidence", dirOf(file), "observation.txt")).equals(observation)).toBe(true);
    expect(file.identity).toContain(sha256(observation));
    // 取得不能: 秘密候補・禁止領域・存在しない・https 以外・秘密候補の URL・名指しの revision が無い。写しを作らず理由を残す
    for (const [source, code] of [
      [secretFile, "SECRET_CANDIDATE"],
      [forbidden, "FORBIDDEN_AREA"],
      [missing, "NOT_FOUND"],
      ["http://example.com/plain", "NOT_HTTPS"],
      ["https://example.com/x?token=abc", "SECRET_CANDIDATE"],
      ["https://user:pw@example.com/y", "SECRET_CANDIDATE"],
    ] as const) {
      const i = ev((x) => x.source === source);
      expect(`${source} ${i.code} ${i.obtained}`).toBe(`${source} ${code} false`);
      expect(i.status).not.toBe("");
      expect(existsSync(join(A, "evidence", dirOf(i)))).toBe(false);
    }
    expect(ev((x) => x.source === secretFile).status).toContain(secretFile);
    expect(anyFileContains(A, "SECRET-VALUE")).toEqual([]);
    // https の URL は認証情報を使わない GET を1回だけ。秘密候補と https 以外は取りに行かない
    expect(curlLog()).toHaveLength(1);
    expect(curlLog()[0]).toContain("-q -fsS --proto =https --proto-redir =https --max-redirs 5 --max-time 60 --max-filesize 20000000 -D ");
    expect(curlLog()[0]?.endsWith(" https://example.com/ok")).toBe(true);
    const url = ev((x) => x.source === "https://example.com/ok");
    expect(url).toMatchObject({ obtained: true, code: "COPIED" });
    expect(url.identity).toContain("200");
    expect(read(join(A, "evidence", dirOf(url), "body"))).not.toContain("CI-IN-URL");
    expect(read(join(P, "evidence", dirOf(url), "body"))).toContain("CI-IN-URL");
    // リンクされていない Document は nod doc show の本文
    const doc = ev((x) => x.source === String(free.id));
    expect(read(join(A, "evidence", dirOf(doc), `document-${free.id}.md`))).toBe(`# 外部の記録\n\n外部の記録\n<!-- ci-result:begin -->\n${REMOVED}\n<!-- ci-result:end -->\n`);
    expect(read(join(P, "evidence", dirOf(doc), `document-${free.id}.md`))).toContain("CI-IN-UNLINKED");
    // Git は revision を commit に固定して show・log だけ。作業ツリーを読まず、状態を変えない
    const g1 = ev((x) => x.source === `${design}@v1:design.md`);
    expect(read(join(A, "evidence", dirOf(g1), "design.md"))).toBe("デザイン v1\n");
    expect(g1.identity).toContain(v1);
    expect(g1.versionMatch).toContain(v1);
    const gh = ev((x) => x.source === `${design}@main:design.md（版履歴）`);
    const history = read(join(A, "evidence", dirOf(gh), "history.txt"));
    expect(history.indexOf(v2)).toBeGreaterThanOrEqual(0);
    expect(history.indexOf(v2)).toBeLessThan(history.indexOf(v1));
    expect(ev((x) => x.source === `${design}@no-such:design.md`)).toMatchObject({ obtained: false, code: "REVISION_NOT_FOUND" });
    expect(anyFileContains(A, "WORKTREE-ONLY")).toEqual([]);
    expect(gitOut(design, "for-each-ref")).toBe(designRefs);
    expect(gitOut(design, "status", "--porcelain")).toBe(designStatus);
    // リポジトリ内の相対パスは写さず、限定 clone の固定版で読む
    const rel = ev((x) => x.source === "src/a.ts");
    expect(rel).toMatchObject({ obtained: false, code: "NOT_COPIED" });
    expect(rel.status).toContain("限定 clone");

    // 目録: 1項目1行、全項目・全欄
    const md = read(join(A, "records.md"));
    const ids = [
      `activity:${a}`,
      `activity:${r2}`,
      `activity:${r1}`,
      `activity:${r4}`,
      `activity:${log}`,
      `activity:${r3}`,
      `document:${note.id}`,
      `document:${ciDoc.id}`,
      ...list.filter((i) => i.id.startsWith("evidence/")).map((i) => i.id),
    ];
    expect(list.map((i) => i.id)).toEqual(expect.arrayContaining(ids));
    expect(list.some((i) => i.id.startsWith("activity@"))).toBe(true);
    for (const i of list) {
      const cells = rowOf(md, i.id);
      expect(`${i.id} ${cells?.length}`).toBe(`${i.id} 13`);
      for (const c of cells ?? []) expect(`${i.id} [${c}]`).not.toBe(`${i.id} []`);
    }
    expect(rowOf(md, `activity:${log}`)?.join(" ")).toContain("除外");
    expect(rowOf(md, file.id)?.join(" ")).toContain(sha256(readFileSync(join(A, "evidence", dirOf(file), "copy"))));
    expect(rowOf(md, file.id)?.join(" ")).toContain(sha256(readFileSync(join(P, "evidence", dirOf(file), "copy"))));
    // 各ファイルの sha256 と出典（records.md を除く）
    for (const f of filesUnder(A).filter((f) => f !== "records.md")) expect(md).toContain(`| \`${f}\` | \`${sha256(readFileSync(join(A, f)))}\` |`);
    // CI の結果の除外の一覧（元の本文の sha256）
    const exclusions = md.slice(md.indexOf("## CI の結果の除外"));
    for (const [label, body] of [
      [`activity:${log}`, "[ci-result] CI-IN-LOG"],
      [`activity:${a} の返信 ${r1}`, "[ci-result] CI-IN-REPLY"],
      [`activity:${a} の返信 ${r4}`, "[ci-result] CI-IN-NESTED"],
      [`activity:${log} の返信 ${r3}`, "ログへの返信 REPLY-OF-CI-LOG"],
      [`document:${ciDoc.id}`, "[ci-result] CI-IN-WHOLE-DOC\n"],
    ] as const) {
      expect(exclusions).toContain(`| ${label} | `);
      expect(exclusions).toContain(sha256(body));
    }
    for (const path of [`document:${note.id}`, `evidence/${dirOf(file)}/copy`, `evidence/${dirOf(doc)}/document-${free.id}.md`, `evidence/${dirOf(url)}/body`]) expect(exclusions).toContain(path);
    // 実行したコマンドの全文と実行ログは親専用領域にだけ置く
    expect(md).not.toContain("--proto");
    expect(md).not.toContain("--no-textconv");
    const detail = read(join(P, "evidence.json"));
    for (const word of ["--proto", "--no-textconv", "rev-parse", "copy-evidence.ts", "doc"]) expect(detail).toContain(word);

    // 受け入れ確認を起動でき、写しの変化は同じ入力の確認で見つかる
    expect((await runReview("agent", ["--work", p.W, "--role", "acceptance", "--event", "start"], s)).exitCode).toBe(0);
    put(join(A, "records.md"), `${md}書き換えた\n`);
    const retire = await runReview<{ redelegate: boolean; identity: Identity }>("retire-attempt", ["--work", p.W, "--role", "acceptance", "--failure", "invalid", "--reason", "9節の1: 失敗を返した"], s);
    expect(retire.json?.redelegate).toBe(false);
    expect(retire.json?.identity.items.filter((i) => !i.ok).map((i) => i.detail).join("\n")).toContain("records.md");
  });

  test("Issue なし: Activity と Document を写さず、明示された証拠と名指しの外部の正本だけを扱い、無ければ「Issue なし、明示された証拠なし」と書く", async () => {
    const s = sandbox();
    const { repo, base, head } = await nodRepo(s);
    const logFile = join(s.t, "evidence/run.log");
    put(logFile, "明示された記録\n");

    const p = await prepareNodWork(s, repo, base, head, null, "single");
    await reachRefute(s, p, refuteVerdict(p, { canon: "出典の場所の記載なし" }));
    expect((await checkRefute(s, p)).json?.valid).toBe(true);
    expect((await runReview("acceptance-records", ["--work", p.W], s)).exitCode).toBe(0);
    expect(existsSync(join(p.W, "acceptance-input/records"))).toBe(false);
    // 参照の一覧を渡さなければ引数の誤り（空でも一覧を渡す）
    expect((await runReview("acceptance-input", ["--work", p.W], s)).exitCode).toBe(2);
    const refs = join(s.t, "refs-single.json");
    put(refs, JSON.stringify([{ type: "file", source: logFile, kind: "明示された証拠", from: "利用者の明示", at: "依頼本文", quote: logFile }]));
    const ai = await runReview<AcceptanceInput>("acceptance-input", ["--work", p.W, "--refs", refs], s);
    expect(ai.json).toMatchObject({ ready: true, status: "準備完了" });
    const list = items(p);
    expect(list.find((i) => i.source === logFile)).toMatchObject({ obtained: true, code: "COPIED", kind: "明示された証拠" });
    // 場所が名指しされていない外部の正本は探さずに取得不能
    expect(list.find((i) => i.kind === "外部の正本")).toMatchObject({ obtained: false, code: "NO_LOCATION", from: "受け入れ確認担当の行 requirements/issue.md:L3（記録の部分）" });
    const md = read(join(p.W, "acceptance-input/records.md"));
    expect(md).toContain("Issue なし");
    expect(md).not.toContain("明示された証拠なし");

    const q = await prepareNodWork(s, repo, base, head, null, "single-none");
    await reachRefute(s, q, refuteVerdict(q));
    expect((await checkRefute(s, q)).json?.valid).toBe(true);
    expect((await runReview("acceptance-records", ["--work", q.W], s)).exitCode).toBe(0);
    const empty = join(s.t, "refs-empty.json");
    put(empty, "[]\n");
    expect((await runReview<AcceptanceInput>("acceptance-input", ["--work", q.W, "--refs", empty], s)).json).toMatchObject({ ready: true });
    expect(read(join(q.W, "acceptance-input/records.md"))).toContain("Issue なし、明示された証拠なし");
  });

  test("評価用の事例: nod を使わず、事例の入力に固定した証拠を inputs/<case-id>/ から写して manifest.md と照合し、入力を固定できなければ未完了にする", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    const curlLog = fakeCurl(s);
    const withEvidence = async (name: string, body: string, recorded: string) => {
      const p = await prepareCaseWork(s, name);
      const dir = join(s.t, "dataset/inputs", name);
      put(join(dir, "evidence/logs/run.log"), body);
      const manifest = read(join(dir, "manifest.md")).replace("| `case.md` |", `| \`evidence/logs/run.log\` | \`${recorded}\` | 当時の記録 |\n| \`case.md\` |`);
      put(join(dir, "manifest.md"), manifest);
      return p;
    };

    // 固定した証拠が manifest.md と一致する
    const body = "当時の実行の記録\n<!-- ci-result:begin -->\nCI-IN-CASE\n<!-- ci-result:end -->\n";
    const p = await withEvidence("case-ok", body, sha256(body));
    await reachRefute(s, p, refuteVerdict(p, { canon: "`https://example.com/design`（v3）" }));
    expect((await checkRefute(s, p)).json?.valid).toBe(true);
    const rec = await runReview("acceptance-records", ["--work", p.W], s);
    expect(rec.exitCode).toBe(0);
    const ai = await runReview<AcceptanceInput>("acceptance-input", ["--work", p.W], s);
    expect(ai.stderr).toBe("");
    expect(ai.json).toMatchObject({ ready: true, status: "準備完了" });
    const A = join(p.W, "acceptance-input");
    const fixed = items(p).find((i) => i.source === "inputs/case-ok/evidence/logs/run.log");
    expect(fixed).toMatchObject({ obtained: true, kind: "事例の入力に固定した証拠" });
    expect(fixed?.method).not.toContain("copy-evidence.ts で");
    expect(fixed?.identity).toContain(sha256(body));
    const d = (fixed?.id ?? "").slice("evidence/".length);
    expect(read(join(A, "evidence", d, "run.log"))).not.toContain("CI-IN-CASE");
    expect(read(join(p.W, "parent/acceptance/evidence", d, "run.log"))).toBe(body);
    // 名指しの外部の正本は当時の版を取れない（現在の正本を取りに行かない）
    expect(items(p).find((i) => i.kind === "外部の正本")).toMatchObject({ obtained: false, code: "CASE_UNAVAILABLE" });
    expect(existsSync(join(A, "records"))).toBe(false);
    expect(nodCalls()).toBe("");
    expect(curlLog()).toEqual([]);

    // 固定した証拠の sha256 が manifest.md と違えば、入力を固定できない
    const bad = await withEvidence("case-bad", body, "0".repeat(64));
    await reachRefute(s, bad, refuteVerdict(bad));
    expect((await checkRefute(s, bad)).json?.valid).toBe(true);
    expect((await runReview("acceptance-records", ["--work", bad.W], s)).exitCode).toBe(0);
    expect((await runReview<AcceptanceInput>("acceptance-input", ["--work", bad.W], s)).json).toMatchObject({ ready: false, status: "未完了", reason: UNFIXED });
    expect((await runReview("agent", ["--work", bad.W, "--role", "acceptance", "--event", "start"], s)).exitCode).toBe(2);

    // 固定した証拠が無ければ「明示された証拠なし」。反証の判定本文の写しが検査時と違えば、入力を固定できない
    const none = await prepareCaseWork(s, "case-none");
    await reachRefute(s, none, refuteVerdict(none));
    expect((await checkRefute(s, none)).json?.valid).toBe(true);
    expect((await runReview("acceptance-records", ["--work", none.W], s)).exitCode).toBe(0);
    put(join(none.W, "acceptance-input/refute-verdict.md"), "書き換えた\n");
    const broken = await runReview<AcceptanceInput>("acceptance-input", ["--work", none.W], s);
    expect(broken.json).toMatchObject({ ready: false, status: "未完了", reason: UNFIXED });
    expect(read(join(none.W, "acceptance-input/records.md"))).toContain("明示された証拠なし");
    expect(read(join(none.W, "parent/acceptance/fingerprints.md"))).toContain("不一致");
    expect(nodCalls()).toBe("");
  });
});
