import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PreparedWork, prepareCaseWork, put, reachRefute, refuteVerdict, runReview, SPEC_TABLE, SPLIT_REQUIREMENTS, type Sandbox, sandbox, sha256 } from "./code-review-review-helpers";

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

// check-refute が親専用領域に残す反証の判定本文の構造（後の段階が点数・確認が残る事項を算出する）。
// files は Spec 探索の引き渡しの要求資料ごとのコード要求、table は Spec 探索の対応表に判定本文の行を重ねた確定した対応表
interface Structure {
  attempt: number;
  sha256: string;
  axes: Record<string, { required: number; unconfirmed: number }>;
  decisions: { id: string; finder: string; verdict: string; impact: number | null; cause: string | null; reason: string }[];
  required: { heading: string; title: string; ids: string[]; impact: number | null; axis: string | null; location: string; effect: string }[];
  files: { path: string; code: string }[];
  table: { source: string; status: string; evidence: string; candidates: string[]; by: string; specStatus: string; specAssignee: string }[];
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
  test("反証の判定本文を機械検査し、判定本文の対応表の行を Spec 探索の対応表に重ねた確定した対応表（確定した担当と Spec 探索の状態付き）・Spec 探索の要求資料ごとのコード要求・未確認と理由を読み取った構造を親専用領域に残す。受け入れ確認の役割とサブコマンドは無い", async () => {
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
    expect(st.axes).toEqual({ Standards: { required: 1, unconfirmed: 0 }, Spec: { required: 0, unconfirmed: 2 } });
    expect(st.decisions.map((d) => [d.id, d.finder, d.verdict, d.impact, d.cause])).toEqual([
      ["STD-1", "Standards 探索", "要対応", 3, "CAUSE-1"],
      ["SPC-1", "Spec 探索", "未確認", null, null],
      ["REF-1", "反証で追加", "要対応", 2, "CAUSE-1"],
    ]);
    expect(st.required).toEqual([{ heading: "CAUSE-1", title: "集計が誤る", ids: ["STD-1", "REF-1"], impact: 2, axis: "Standards", location: "src/a.ts@HEAD:L1", effect: "集計が誤る" }]);
    // 要求資料ごとのコード要求は Spec 探索の引き渡しのもの（判定本文には書かない）
    expect(st.files).toEqual([
      { path: "requirements/issue.md", code: "あり" },
      { path: "requirements/workspace-rules.md", code: "なし" },
    ]);
    // Spec 探索の表の順で、判定本文に書いた L3 は反証が確定し、書いていない充足の L4 は Spec 探索の判定のまま。セル内のコードの | は区切りにしない
    expect(st.table).toEqual([
      { source: "requirements/issue.md:L3", status: "未確認", evidence: "依存の独自パッチの契約が入力に無く、a | b の分岐の結論を出せない", candidates: ["SPC-1"], by: "反証", specStatus: "未確認", specAssignee: "spec" },
      { source: "requirements/issue.md:L4", status: "充足", evidence: "src/a.ts@HEAD:L1", candidates: [], by: "Spec 探索", specStatus: "充足", specAssignee: "spec" },
    ]);
    // 表から除いた行と追加の印は無い
    expect(Object.keys(st)).not.toContain("removed");
    expect(Object.keys(st)).not.toContain("added");
    expect(st.unconfirmed.map((u) => [u.ref, u.kind, u.owner])).toEqual([
      ["SPC-1", "候補", "人"],
      ["requirements/issue.md:L3", "要求", "人"],
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

  test("充足から未充足: 要対応の契約の出典と行範囲で重なる充足の行（同じ要求資料の複数範囲をまとめた行も）が充足のまま残れば無効にし、行全体を未充足にして候補 ID を書けば反証の行として重ねる。重ならない範囲・別の要求資料・充足でない行は無効にしない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const MERGED = "`requirements/issue.md:L2`、`requirements/issue.md:L4-L5`";
    const table = [SPEC_TABLE[0] ?? "", `| ${MERGED} | 充足 | \`src/a.ts@HEAD:L1\`、\`src/a.ts@HEAD:L1-L1\` | なし |`, "| `requirements/workspace-rules.md:L3` | 充足 | `src/a.ts@HEAD:L1` | なし |"];
    await reachRefute(s, p, refuteVerdict(p), { table, files: ["| `requirements/issue.md` | あり |", "| `requirements/workspace-rules.md` | あり |"] });
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });

    // 重なる契約の出典（範囲の中の1行・まとめた行の別の範囲・範囲の一部にまたがる範囲・終わりの L を省いた範囲・場所と並べた範囲）: まとめた充足の行が充足のまま残れば無効
    for (const contract of ["`requirements/issue.md:L4`", "`requirements/issue.md:L2`", "`requirements/issue.md:L5-L7`", "`requirements/issue.md:L3-9`", "`src/a.ts@HEAD:L1`、`requirements/issue.md:L1-L2`"]) {
      put(join(p.W, "refute/verdict.md"), refuteVerdict(p, { contract }));
      const r = await checkRefute(s, p);
      expect(`${contract}: ${r.json?.valid}`).toBe(`${contract}: false`);
      expect(`${contract}: ${messages(r.json, 4)}`).toContain("CAUSE-1");
      expect(`${contract}: ${messages(r.json, 4)}`).toContain("requirements/issue.md:L2、requirements/issue.md:L4-L5");
      expect(existsSync(join(p.W, "parent/refute-structure.json"))).toBe(false);
    }
    // 重ならない範囲、別の要求資料の同じ行番号、反証が未確認のまま確定した行に当たる契約の出典は無効にしない
    for (const contract of ["`requirements/issue.md:L6-L9`", "`requirements/workspace-rules.md:L4-L5`", "`requirements/issue.md:L3`"]) {
      put(join(p.W, "refute/verdict.md"), refuteVerdict(p, { contract }));
      expect(`${contract}: ${(await checkRefute(s, p)).json?.valid}`).toBe(`${contract}: true`);
    }

    // まとめた行の一部が当たるので、行全体を未充足にして要対応の候補 ID を書いた。重ねた表では反証が確定した行になる
    put(join(p.W, "refute/verdict.md"), refuteVerdict(p, { contract: "`requirements/issue.md:L4`", unmet: [MERGED] }));
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    expect(structure(p).table).toEqual([
      { source: "requirements/issue.md:L3", status: "未確認", evidence: "依存の独自パッチの契約が入力に無く、a | b の分岐の結論を出せない", candidates: ["SPC-1"], by: "反証", specStatus: "未確認", specAssignee: "spec" },
      { source: "requirements/issue.md:L2、requirements/issue.md:L4-L5", status: "未充足", evidence: "失敗を記録しない（src/a.ts@HEAD:L1）", candidates: ["STD-1"], by: "反証", specStatus: "充足", specAssignee: "spec" },
      { source: "requirements/workspace-rules.md:L3", status: "充足", evidence: "src/a.ts@HEAD:L1", candidates: [], by: "Spec 探索", specStatus: "充足", specAssignee: "spec" },
    ]);
    expect(structure(p).files.map((f) => f.code)).toEqual(["あり", "あり"]);

    // まとめた行を分けて一部だけを未充足にした行は、Spec 探索の対応表に無い行として無効
    put(join(p.W, "refute/verdict.md"), refuteVerdict(p, { contract: "`requirements/issue.md:L4`", unmet: ["`requirements/issue.md:L4-L5`"] }));
    const split = await checkRefute(s, p);
    expect(split.json?.valid).toBe(false);
    expect(messages(split.json, 4)).toContain("requirements/issue.md:L4-L5");
  });

  test("候補の判定「基点から存在（対象外）」と別枠の課題の記載は拒否しない", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p)
      .replace("| SPC-1 | Spec 探索 | 未確認 | なし | なし | 依存の独自パッチの契約が入力に無い |", "| SPC-1 | Spec 探索 | 基点から存在（対象外） | なし | なし | merge-base に同じ分岐があり、今回の要求も修正を求めていない |")
      .replace("| SPC-1 | Spec | 候補 | 依存の独自パッチの契約が入力に無い | 人 | 独自パッチの契約 |\n", "")
      .replace("- Spec: 要対応 0 件、未確認 2 件", "- Spec: 要対応 0 件、未確認 1 件")
      .replace("## 基点から存在する課題（別枠）\n\nなし\n", "## 基点から存在する課題（別枠）\n\n- SPC-1: merge-base に同じ分岐があり、今回の差分は悪化させていない\n");
    await reachRefute(s, p, verdict);
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    expect(structure(p).decisions.find((d) => d.id === "SPC-1")?.verdict).toBe("基点から存在（対象外）");
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

  test("分けた要求: 2体の引き渡しの対応表を担当の順（spec1 → spec2）につないだ表を Spec 探索の対応表として、両方の候補と判定本文の行を今と同じ規則で検査し、確定した対応表の各行にその行を書いた担当を残す。要対応の契約の出典と重なる充足の行の規則はつないだ表の全体に当てる", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s, "split", SPLIT_REQUIREMENTS);
    const RULE = "| `requirements/workspace-rules.md:L3` | 充足 | `src/a.ts@HEAD:L1` | なし |";
    // spec1 は既定の L3（未確認、SPC1-1）と L4（充足）、spec2 は規約の L3（充足）と候補 SPC2-1。判定本文は SPC1-1 を未確認、SPC2-1 を棄却にする
    const verdict = refuteVerdict(p);
    await reachRefute(s, p, verdict, { handoffs: { spec2: { files: ["| `requirements/workspace-rules.md` | あり |"], table: [RULE] } } });
    const r = await checkRefute(s, p);
    expect(r.json).toMatchObject({ valid: true, violations: [] });
    const st = structure(p);
    expect(st.decisions.map((d) => [d.id, d.verdict])).toEqual([
      ["STD-1", "要対応"],
      ["SPC1-1", "未確認"],
      ["SPC2-1", "棄却"],
      ["REF-1", "要対応"],
    ]);
    expect(st.files).toEqual([
      { path: "requirements/issue.md", code: "あり" },
      { path: "requirements/workspace-rules.md", code: "あり" },
    ]);
    expect(st.table).toEqual([
      { source: "requirements/issue.md:L3", status: "未確認", evidence: "依存の独自パッチの契約が入力に無く、a | b の分岐の結論を出せない", candidates: ["SPC1-1"], by: "反証", specStatus: "未確認", specAssignee: "spec1" },
      { source: "requirements/issue.md:L4", status: "充足", evidence: "src/a.ts@HEAD:L1", candidates: [], by: "Spec 探索", specStatus: "充足", specAssignee: "spec1" },
      { source: "requirements/workspace-rules.md:L3", status: "充足", evidence: "src/a.ts@HEAD:L1", candidates: [], by: "Spec 探索", specStatus: "充足", specAssignee: "spec2" },
    ]);
    // 反証への写しは2体の引き渡しの原文のまま
    expect(read(join(p.W, "refute-input/spec2-handoff.md"))).toBe(read(join(p.W, "spec2/handoff.md")));

    const cases: [string, string, number, string][] = [
      ["spec2 の候補の採否漏れ", verdict.replace("| SPC2-1 | Spec 探索 | 棄却 | なし | なし | 固定版で到達しない |\n", ""), 3, "SPC2-1"],
      ["spec1 の未確認の行の確定漏れ", verdict.replace(/^\| `requirements\/issue\.md:L3` \| 未確認 .*\n/m, ""), 4, "requirements/issue.md:L3"],
      ["spec2 の範囲の充足の行が要対応の契約の出典と重なる", refuteVerdict(p, { contract: "`requirements/workspace-rules.md:L3`" }), 4, "requirements/workspace-rules.md:L3"],
    ];
    for (const [name, text, no, needle] of cases) {
      put(join(p.W, "refute/verdict.md"), text);
      const x = await checkRefute(s, p);
      expect(`${name}: ${x.json?.valid}`).toBe(`${name}: false`);
      expect(`${name}: ${messages(x.json, no)}`).toContain(needle);
    }
    // spec2 の行全体を未充足にして要対応の候補 ID を書けば、反証が確定した spec2 の行になる
    put(join(p.W, "refute/verdict.md"), refuteVerdict(p, { contract: "`requirements/workspace-rules.md:L3`", unmet: ["`requirements/workspace-rules.md:L3`"] }));
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    expect(structure(p).table.at(-1)).toMatchObject({ source: "requirements/workspace-rules.md:L3", status: "未充足", by: "反証", specStatus: "充足", specAssignee: "spec2" });
  });

  test("分けた要求: 1つの要求資料が2つの範囲にまたがるとき、要求資料ごとのコード要求はどちらかの担当が「あり」なら「あり」にまとめる", async () => {
    const s = sandbox();
    // 全4行を見出しの直前（位置 2）で分ける: spec1 = requirements/issue.md:L1-L2、spec2 = requirements/issue.md:L3-L4
    const p = await prepareCaseWork(s, "split-file", { "issue.md": "# 課題\n背景\n## 要求\n- a は 1 を返す\n" });
    await reachRefute(s, p, refuteVerdict(p, { empty: true }), { empty: true, handoffs: { spec2: { files: ["| `requirements/issue.md` | あり |"], table: ["| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` | なし |"] } } });
    expect(read(join(p.W, "refute-input/spec1-handoff.md"))).toContain("| `requirements/issue.md` | なし |");
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    const st = structure(p);
    expect(st.files).toEqual([{ path: "requirements/issue.md", code: "あり" }]);
    expect(st.table).toEqual([{ source: "requirements/issue.md:L4", status: "充足", evidence: "src/a.ts@HEAD:L1", candidates: [], by: "Spec 探索", specStatus: "充足", specAssignee: "spec2" }]);
  });

  test("コード要求0件: 両探索と反証の空の対応表（要求資料はどれもコード要求なし。括弧1つの注記付きも可）を正常として合格させ、要求資料ごとのコード要求は Spec 探索の引き渡しから読む", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    const verdict = refuteVerdict(p, { empty: true });
    await reachRefute(s, p, verdict, { empty: true, files: ["| `requirements/issue.md` | なし（背景の説明だけ） |", "| `requirements/workspace-rules.md` | なし |"] });
    expect((await checkRefute(s, p)).json).toMatchObject({ valid: true, violations: [] });
    const st = structure(p);
    expect(st.table).toEqual([]);
    expect(st.decisions).toEqual([]);
    expect(st.files).toEqual([
      { path: "requirements/issue.md", code: "なし" },
      { path: "requirements/workspace-rules.md", code: "なし" },
    ]);
  });

  test("形式違反（Spec 探索の未充足・未確認の行の確定漏れ・Spec 探索に無い行・充足の行を未充足以外で書いた行・出典の重複・要対応の契約の出典と重なる充足の行・状態と結論の不整合・廃止した状態・担当・理由・軸ごとの集計の不一致・採否一覧の候補漏れ・影響度の欠落・同一候補の判定の不一致・未確認の表の欠落）を無効にする", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s);
    // Spec 探索の L3 は未確認、L4 は充足、L2 は未充足。反証は L3 を未確認、L2 を未充足のまま確定して書く
    const v = refuteVerdict(p, { unmet: ["`requirements/issue.md:L2`"] });
    await reachRefute(s, p, v, { table: [...SPEC_TABLE, "| `requirements/issue.md:L2` | 未充足 | 失敗を記録しない（`src/a.ts@HEAD:L1`） | SPC-1 |"] });
    const L3 = "| `requirements/issue.md:L3` | 未確認 | 依存の独自パッチの契約が入力に無く、`a | b` の分岐の結論を出せない | SPC-1 |\n";
    const L2 = "| `requirements/issue.md:L2` | 未充足 | 失敗を記録しない（`src/a.ts@HEAD:L1`） | STD-1 |\n";
    const L3_UNCONFIRMED = "| `requirements/issue.md:L3` | Spec | 要求 | 依存の独自パッチの契約が入力に無く、分岐の結論を出せない | 人 | 独自パッチの契約 |\n";
    const cases: [string, string, number, string][] = [
      ["Spec 探索の未確認の行の確定漏れ", v.replace(L3, ""), 4, "requirements/issue.md:L3"],
      ["Spec 探索の未充足の行の確定漏れ", v.replace(L2, ""), 4, "requirements/issue.md:L2"],
      ["Spec 探索に無い行（反証が足した行）", v.replace(L3, `${L3}| \`requirements/issue.md:L1\` | 未確認 | 失敗の記録先を決める契約が要求資料に無い | なし |\n`), 4, "requirements/issue.md:L1"],
      ["Spec 探索で充足の行を充足のまま書いた", v.replace(L3, `${L3}| \`requirements/issue.md:L4\` | 充足 | \`src/a.ts@HEAD:L1\` | なし |\n`), 4, "requirements/issue.md:L4"],
      ["Spec 探索で充足の行を未確認に変えた", v.replace(L3, `${L3}| \`requirements/issue.md:L4\` | 未確認 | 記録先の契約が入力に無い | なし |\n`), 4, "requirements/issue.md:L4"],
      ["判定本文の表の出典の重複", v.replace(L3, `${L3}${L3}`), 4, "重複"],
      ["対応表の節の欠落", v.replace(/## コード要求の対応表（反証で確定した行）\n[\s\S]*?\n## 未確認と理由/, "## 未確認と理由"), 4, "コード要求の対応表"],
      ["要対応の契約の出典と重なる充足の行が残る", v.replace("- 契約の出典: `src/a.ts@HEAD:L1`", "- 契約の出典: `requirements/issue.md:L4`"), 4, "requirements/issue.md:L4"],
      ["未充足の行に要対応が無い", v.replace(L2, "| `requirements/issue.md:L2` | 未充足 | 失敗を記録しない | なし |\n"), 4, "要対応"],
      ["廃止した状態", v.replace(L3, "| `requirements/issue.md:L3` | 自動チェック担当 | テストで確かめる | SPC-1 |\n"), 4, "自動チェック担当"],
      ["対応表の未確認の理由に要実行確認", v.replace(L3, "| `requirements/issue.md:L3` | 未確認 | 要実行確認 | SPC-1 |\n"), 4, "要実行確認"],
      ["廃止した確かめる担当", v.replace(L3_UNCONFIRMED, L3_UNCONFIRMED.replace("| 人 |", "| 受け入れ確認担当 |")), 5, "受け入れ確認担当"],
      ["未確認の理由に要実行確認", v.replace(L3_UNCONFIRMED, L3_UNCONFIRMED.replace("分岐の結論を出せない", "要実行確認")), 5, "要実行確認"],
      ["重ねた表の未確認の行が未確認の表に無い", v.replace(L3_UNCONFIRMED, "").replace("未確認 2 件", "未確認 1 件"), 5, "requirements/issue.md:L3"],
      ["軸ごとの要対応の件数の不一致", v.replace("- Standards: 要対応 1 件", "- Standards: 要対応 2 件"), 5, "Standards"],
      ["軸ごとの未確認の件数の不一致", v.replace("- Spec: 要対応 0 件、未確認 2 件", "- Spec: 要対応 0 件、未確認 1 件"), 5, "Spec"],
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
