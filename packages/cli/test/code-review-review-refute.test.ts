import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PreparedWork, prepareCaseWork, put, reachRefute, refuteVerdict, runReview, type Sandbox, sandbox, sha256 } from "./code-review-review-helpers";

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
  structure: string | null;
}

// check-refute が親専用領域に残す反証の判定本文の構造（後の段階が点数・確認が残る事項を算出する）
interface Structure {
  attempt: number;
  sha256: string;
  axes: Record<string, { required: number; unconfirmed: number }>;
  decisions: { id: string; finder: string; verdict: string; impact: number | null; cause: string | null; reason: string }[];
  required: { heading: string; title: string; ids: string[]; impact: number | null; axis: string | null; location: string; effect: string }[];
  files: { path: string; code: string }[];
  table: { source: string; status: string; evidence: string; candidates: string[]; added: boolean }[];
  removed: { source: string; reason: string }[];
  unconfirmed: { ref: string; axis: string; kind: string; reason: string; owner: string; missing: string }[];
}

const read = (path: string) => readFileSync(path, "utf8");
const structure = (p: PreparedWork) => JSON.parse(read(join(p.W, "parent/refute-structure.json"))) as Structure;

const checkRefute = (s: Sandbox, p: PreparedWork) => runReview<CheckRefute>("check-refute", ["--work", p.W], s);
const messages = (r: CheckRefute | undefined, no: number) =>
  (r?.violations ?? [])
    .filter((v) => v.no === no)
    .map((v) => v.message)
    .join("\n");

describe("code-review の反証の検査（review.ts check-refute）", () => {
  test("反証の判定本文を機械検査し、コード要求の対応表・要求資料ごとのコード要求・追加の印・未確認と理由を読み取った構造を親専用領域に残す。受け入れ確認の役割とサブコマンドは無い", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p);
    await reachRefute(s, p, verdict);

    const r = await checkRefute(s, p);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, stage: "refute", role: "refute", attempt: 1, agentId: "agent-refute", valid: true, violations: [], file: "refute/verdict.md", sha256: sha256(verdict), structure: "parent/refute-structure.json" });
    expect(Object.keys(r.json ?? {})).not.toContain("acceptanceRows");
    expect(r.json?.identity.ok).toBe(true);
    expect(r.json?.identity.items.map((i) => i.name).join("\n")).toContain("refute-input/");
    // 判定本文を書き換えない
    expect(read(join(p.W, "refute/verdict.md"))).toBe(verdict);
    expect(JSON.parse(read(join(p.W, "parent/check-refute.json")))).toEqual(r.json);
    expect(read(join(p.W, "parent/checks.md"))).toContain(sha256(verdict));

    const st = structure(p);
    expect(st).toMatchObject({ attempt: 1, sha256: sha256(verdict) });
    expect(Object.keys(st)).not.toContain("acceptanceRows");
    expect(st.axes).toEqual({ Standards: { required: 1, unconfirmed: 0 }, Spec: { required: 0, unconfirmed: 3 } });
    expect(st.decisions.map((d) => [d.id, d.finder, d.verdict, d.impact, d.cause])).toEqual([
      ["STD-1", "Standards 探索", "要対応", 3, "CAUSE-1"],
      ["SPC-1", "Spec 探索", "未確認", null, null],
      ["REF-1", "反証で追加", "要対応", 2, "CAUSE-1"],
    ]);
    expect(st.required).toEqual([{ heading: "CAUSE-1", title: "集計が誤る", ids: ["STD-1", "REF-1"], impact: 2, axis: "Standards", location: "src/a.ts@HEAD:L1", effect: "集計が誤る" }]);
    expect(st.files).toEqual([
      { path: "requirements/issue.md", code: "あり" },
      { path: "requirements/workspace-rules.md", code: "なし" },
    ]);
    expect(st.table.map((t) => [t.source, t.status, t.candidates, t.added])).toEqual([
      ["requirements/issue.md:L3", "未確認", ["SPC-1"], false],
      ["requirements/issue.md:L4", "充足", [], false],
      ["requirements/issue.md:L2", "未確認", [], true],
    ]);
    // セル内のコードの | は区切りにしない
    expect(st.table[1]?.evidence).toBe("src/a.ts@HEAD:L1 の a | b");
    expect(st.removed).toEqual([]);
    expect(st.unconfirmed.map((u) => [u.ref, u.kind, u.owner])).toEqual([
      ["SPC-1", "候補", "人"],
      ["requirements/issue.md:L3", "要求", "人"],
      ["requirements/issue.md:L2", "要求", "人"],
    ]);

    // 受け入れ確認の役割と、受け入れ確認専用のサブコマンドは無い（引数の誤り）
    for (const [sub, args] of [
      ["agent", ["--role", "acceptance", "--event", "start"]],
      ["retire-attempt", ["--role", "acceptance", "--failure", "invalid", "--reason", "x"]],
      ["acceptance-records", []],
      ["acceptance-input", []],
      ["check-acceptance", []],
    ] as const) {
      const x = await runReview<{ code: string }>(sub, ["--work", p.W, ...args], s);
      expect(`${sub}: ${x.exitCode} ${x.json?.code}`).toBe(`${sub}: 2 INVALID_INPUT`);
    }
    expect(read(join(p.W, "parent/agents.md"))).not.toContain("受け入れ確認");
    expect(existsSync(join(p.W, "parent/acceptance"))).toBe(false);
  });

  test("表から除いた行: Spec 探索の行を確定表から外すときは出典と1行の理由を記録すれば有効で、関連候補の採否は採否一覧に残る。候補の判定「基点から存在（対象外）」や本文の「説明」は拒否しない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p, { removed: true });
    await reachRefute(s, p, verdict);
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    const st = structure(p);
    expect(st.table.map((t) => t.source)).toEqual(["requirements/issue.md:L4", "requirements/issue.md:L2"]);
    expect(st.removed).toEqual([{ source: "requirements/issue.md:L3", reason: "背景の説明で、コードが満たす要求ではない" }]);
    expect(st.decisions.find((d) => d.id === "SPC-1")?.verdict).toBe("基点から存在（対象外）");
  });

  test("CAUSEに採用候補がなければ無効にし、採用された兄弟候補がある集約は許す", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    const oneRejected = v.replace("| STD-1 | Standards 探索 | 要対応 | 3 | CAUSE-1 |", "| STD-1 | Standards 探索 | 棄却 | なし | CAUSE-1 |");
    const allRejected = oneRejected.replace("| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 |", "| REF-1 | 反証で追加 | 棄却 | なし | CAUSE-1 |");
    await reachRefute(s, p, allRejected);
    const invalid = await checkRefute(s, p);
    expect(invalid.json?.valid).toBe(false);
    expect(messages(invalid.json, 3)).toContain("要対応の候補が無い");
    expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
    put(join(p.W, "refute/verdict.md"), oneRejected);
    expect((await checkRefute(s, p)).json?.valid).toBe(true);
    expect(structure(p).required).toMatchObject([{ heading: "CAUSE-1", impact: 2 }]);
  });

  test("要対応の必須根拠欄が欠けるか空なら有効な反証として保存しない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    await reachRefute(s, p, v);
    for (const field of ["場所", "起点", "到達条件", "期待動作", "破綻", "影響", "証拠", "契約の出典", "関連する要求・契約", "反証の判定理由"]) {
      for (const replacement of ["", `- ${field}:   \n`]) {
        put(join(p.W, "refute/verdict.md"), v.replace(new RegExp(`^- ${field}:.*\\n`, "m"), replacement));
        const r = await checkRefute(s, p);
        expect(r.json?.valid).toBe(false);
        expect(messages(r.json, 3)).toContain(field);
        expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
      }
    }
  });

  test("重複する対象版は順序や同一値に関係なく拒否し、有効な判定構造を残さない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    await reachRefute(s, p, v);
    expect((await checkRefute(s, p)).json?.valid).toBe(true);
    for (const replacement of [`$1- 対象版: ${"f".repeat(40)}\n`, `- 対象版: ${"f".repeat(40)}\n$1`, "$1$1"]) {
      put(join(p.W, "refute/verdict.md"), v.replace(/(- 対象版: .*\n)/, replacement));
      const r = await checkRefute(s, p);
      expect(r.json?.valid).toBe(false);
      expect(messages(r.json, 2)).toContain("対象版」が重複");
      expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
    }
  });

  test("別の同名節に対象版を書いても重複を拒否し、番号付きの節も同じ名前として扱う", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    await reachRefute(s, p, v);
    expect((await checkRefute(s, p)).json?.valid).toBe(true);
    for (const extra of [`## 担当と対象\n\n- 対象版: ${"f".repeat(40)}`, `## 99. 担当と対象\n\n- 対象版: ${"f".repeat(40)}`, `## 担当と対象\n\n- 対象版: ${p.clone}／commit／${p.base}／${p.head}`]) {
      put(join(p.W, "refute/verdict.md"), `${v}\n${extra}\n`);
      const r = await checkRefute(s, p);
      expect(r.json?.valid).toBe(false);
      expect(messages(r.json, 2)).toContain("「担当と対象」の節が重複");
      expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
    }
  });

  test("コード要求0件: 両探索と反証の空の対応表（要求資料はどれもコード要求なし。括弧1つの注記付きも可）を正常として合格させる", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p, { empty: true, files: ["| `requirements/issue.md` | なし（背景の説明だけ） |", "| `requirements/workspace-rules.md` | なし |"] });
    await reachRefute(s, p, verdict, { empty: true });
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    const st = structure(p);
    expect(st.table).toEqual([]);
    expect(st.decisions).toEqual([]);
    expect(st.files.map((f) => f.code)).toEqual(["なし", "なし"]);
  });

  test("形式違反（探索の行の確定漏れ・除いた行の理由の欠落・要求資料ごとの記載の欠落・状態と結論の不整合・廃止した状態・担当・分類・理由・軸ごとの集計の不一致・採否一覧の候補漏れ・影響度の欠落・同一候補の判定の不一致・未確認の表の欠落）を無効にする", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const v = refuteVerdict(p);
    await reachRefute(s, p, v);
    const L4 = "| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` の `a | b` | なし |\n";
    const L2_UNCONFIRMED = "| `requirements/issue.md:L2` | Spec | 要求 | 失敗の記録先を決める要求資料が無い | 人 | 記録先の契約 |\n";
    const removedSection = (rows: string) => v.replace("## 表から除いた行\n\nなし\n", `## 表から除いた行\n\n| 要求の出典 | 理由 |\n|---|---|\n${rows}`);
    const cases: [string, string, number, string][] = [
      ["Spec 探索の行の確定漏れ", v.replace(L4, ""), 4, "requirements/issue.md:L4"],
      ["除いた行の理由の欠落", removedSection("| `requirements/issue.md:L4` |  |\n").replace(L4, ""), 4, "理由"],
      ["除いた行の節の欠落", v.replace("## 表から除いた行\n\nなし\n\n", ""), 4, "表から除いた行"],
      ["除いた行の理由に廃止した分類", removedSection("| `requirements/issue.md:L4` | 作業手順の規則 |\n").replace(L4, ""), 4, "作業手順の規則"],
      ["要求資料ごとの記載の欠落", v.replace("| `requirements/workspace-rules.md` | なし |\n", ""), 4, "requirements/workspace-rules.md"],
      ["補足の後ろに続く値", v.replace("| `requirements/issue.md` | あり |", "| `requirements/issue.md` | あり（L3・L4）なし |"), 4, "「あり（L3・L4）なし」"],
      ["未充足の行に要対応が無い", v.replace(L4, "| `requirements/issue.md:L4` | 未充足 | 記録しない | なし |\n"), 4, "要対応"],
      ["廃止した状態", v.replace(L4, "| `requirements/issue.md:L4` | 自動チェック担当 | テストで確かめる | なし |\n"), 4, "自動チェック担当"],
      ["対応表の未確認の理由に要実行確認", v.replace("（追加）失敗の記録先を決める契約が要求資料に無い", "（追加）要実行確認"), 4, "要実行確認"],
      ["廃止した確かめる担当", v.replace(L2_UNCONFIRMED, L2_UNCONFIRMED.replace("| 人 |", "| 受け入れ確認担当 |")), 5, "受け入れ確認担当"],
      ["未確認の理由に要実行確認", v.replace(L2_UNCONFIRMED, L2_UNCONFIRMED.replace("失敗の記録先を決める要求資料が無い", "要実行確認")), 5, "要実行確認"],
      ["未確認の行が未確認の表に無い", v.replace(L2_UNCONFIRMED, "").replace("未確認 3 件", "未確認 2 件"), 5, "requirements/issue.md:L2"],
      ["軸ごとの要対応の件数の不一致", v.replace("- Standards: 要対応 1 件", "- Standards: 要対応 2 件"), 5, "Standards"],
      ["軸ごとの未確認の件数の不一致", v.replace("- Spec: 要対応 0 件、未確認 3 件", "- Spec: 要対応 0 件、未確認 1 件"), 5, "Spec"],
      ["採否一覧の候補漏れ", v.replace("| SPC-1 | Spec 探索 | 未確認 | なし | なし | 依存の独自パッチの契約が入力に無い |\n", ""), 3, "SPC-1"],
      ["反証で追加した発見の採否漏れ", v.replace("| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 | 固定版で確かめた |\n", ""), 3, "REF-1"],
      ["要対応の影響度の欠落", v.replace("| STD-1 | Standards 探索 | 要対応 | 3 |", "| STD-1 | Standards 探索 | 要対応 |  |"), 3, "STD-1"],
      ["同一候補の判定の不一致", v.replace("| REF-1 | 反証で追加 | 要対応 | 2 | CAUSE-1 |", "| REF-1 | 反証で追加 | 棄却 | なし | なし |"), 3, "REF-1"],
      ["同一原因の影響度が集約と違う", v.replace("- 影響度: 2", "- 影響度: 3"), 3, "CAUSE-1"],
      ["未確認と理由が自由記述", v.replace(/## 未確認と理由\n[\s\S]*?\n## 判断を見送った事項/, "## 未確認と理由\n\nSPC-1 は契約が無いので未確認。\n\n## 判断を見送った事項"), 5, "未確認と理由"],
    ];
    for (const [name, text, no, needle] of cases) {
      expect(`${name}: ${text === v}`).toBe(`${name}: false`);
      put(join(p.W, "refute/verdict.md"), text);
      const r = await checkRefute(s, p);
      expect(r.exitCode).toBe(0);
      expect(`${name}: ${r.json?.valid}`).toBe(`${name}: false`);
      expect(`${name}: ${messages(r.json, no)}`).toContain(needle);
    }
    // 無効な判定本文からは構造を残さない
    expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);

    // 無効な結果は retire-attempt で隔離し、反証だけを1回委譲し直して同じ検査をする
    const retire = await runReview<{ redelegate: boolean }>("retire-attempt", ["--work", p.W, "--role", "refute", "--failure", "invalid", "--reason", "7節の4: 探索の行の確定漏れ"], s);
    expect(retire.json?.redelegate).toBe(true);
    expect((await runReview("agent", ["--work", p.W, "--role", "refute", "--event", "start"], s)).exitCode).toBe(0);
    put(join(p.W, "refute/verdict.md"), v);
    expect((await runReview("agent", ["--work", p.W, "--role", "refute", "--event", "received", "--agent-id", "agent-refute-2"], s)).exitCode).toBe(0);
    const ok = await checkRefute(s, p);
    expect(ok.json).toMatchObject({ valid: true, attempt: 2, agentId: "agent-refute-2" });
  });
});
