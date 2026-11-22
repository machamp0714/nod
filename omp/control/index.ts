// pstack を OMP で使う組の制御の拡張。適用（scripts/pstack-omp/cli.ts apply）が nod のデータ置き場の pstack-omp/omp/control に写し、
// 利用者の OMP の設定の extensions にこのディレクトリだけを登録する。読み込みの設定は、同じ写しの harness.json（適用が書く組の記録）から読む。
//
// - 組の記録を検証する（読める、形が正しい、指すディレクトリがある、組の各ファイルの sha256 が記録と同じ）。
//   正しくなければ、メインでも子でも全ツールを遮断し、理由を返す（新しい構成のまま、読み込み先が壊れた状態でツールを使わせない）。
// - 正しければ、拡張の読み込み（factory）で実行時の層（永続しない。global・project・--config より強い）に読み込みの設定を書く。
//   セッションの開始（session_start）より前に書くのは、メインの task ツールが作られるときにエージェント定義を探すので、
//   そのときまでに OMP 向けのディレクトリ（content）が extensions に入っていないと、メインの task の一覧に poteto-agent が出ないため。
//   factory はセッションごと（子と孫も）に呼ばれ、同じプロセスの子と孫は親と同じ設定を使うので、同じ値を書き直すだけになる。
//   worker thread の写し（mirror）の設定には書かない（親の設定を写したもので、親が既に書いている）。
// - TUI は、providers・shortcuts・renderer などを何も登録しない拡張の読み込みを、入力欄の表示の後に回すことがある
//   （OMP の extensibility/extensions/startup-deferral.ts）。そうなると task ツールが作られた後に書くことになるので、
//   後回しにさせないため、customType が pstack-omp の message renderer を登録する（この拡張はその種類のメッセージを送らない）。
// - このプロセスが適用より前に始まっていたら（適用より前のセッションに、後から読み込まれたとき）、何もしない。新しいセッションから効く。
// 検証はプロセスで1度だけ行い、同じプロセスの全セッション（メイン・子・孫）で同じ結果を使う。
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

const HERE = import.meta.dir;
// 写しの根（content/ と control/ を持つ）
const ROOT = dirname(HERE);
const HARNESS = join(HERE, "harness.json");
const NAME = "pstack-omp";

// 組の記録のうち、この拡張が使う部分
interface Harness {
  appliedAt: string;
  pin: { commit: string };
  content: string;
  control: string;
  skillDirectories: string[];
  manualSkills: string[];
  // 写しの根からの相対パス → sha256
  files: Record<string, string>;
}

type Verdict = { kind: "ok"; harness: Harness } | { kind: "blocked"; reason: string } | { kind: "stale"; appliedAt: string };

let verdict: Verdict | undefined;

export default function control(pi: ExtensionAPI): void {
  verdict ??= judge();
  pi.registerMessageRenderer(NAME, (message) => ({ render: () => [String(message.content)], invalidate: () => {} }));
  const current = verdict;
  if (current.kind === "ok" && !isMirror(pi.pi.settings)) {
    try {
      overrideSettings(pi.pi.settings, current.harness);
    } catch (e) {
      verdict = blocked(`読み込みの設定を書けませんでした: ${(e as Error).message}`);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent?.kind !== "main") return;
    const current = verdict!;
    if (current.kind === "stale") {
      report(ctx, `${NAME}: 適用（${current.appliedAt}）より前に始まったプロセスなので、このセッションには読み込みません。新しいセッションから効きます`, "info");
      return;
    }
    if (current.kind === "blocked") {
      report(ctx, `${NAME}: ${current.reason}`, "error");
      return;
    }
    const { harness } = current;
    report(ctx, `${NAME}: 適用（${harness.appliedAt}、pin ${harness.pin.commit.slice(0, 12)}）の組を読み込みました（一覧から外すスキル ${harness.manualSkills.length} 個）`, "info");
  });

  pi.on("tool_call", () => {
    const current = verdict!;
    return current.kind === "blocked" ? { block: true, reason: `${NAME}: ${current.reason}` } : undefined;
  });
}

function blocked(reason: string): Extract<Verdict, { kind: "blocked" }> {
  return {
    kind: "blocked",
    reason: `${reason}。組（${ROOT}）が正しくないので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください`,
  };
}

function judge(): Verdict {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(HARNESS, "utf8"));
  } catch (e) {
    return blocked(`組の記録 ${HARNESS} を読めません: ${(e as Error).message}`);
  }
  const harness = parseHarness(raw);
  if (typeof harness === "string") return blocked(`組の記録 ${HARNESS} の形が正しくありません: ${harness}`);
  if (real(harness.control) !== real(HERE)) return blocked(`組の記録の control（${harness.control}）がこの拡張の置き場（${HERE}）と違います`);
  for (const dir of [harness.content, ...harness.skillDirectories]) {
    if (!isDirectory(dir)) return blocked(`組の記録が指すディレクトリ ${dir} がありません`);
  }
  const mismatched = Object.entries(harness.files).filter(([rel, sha]) => {
    try {
      return createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex") !== sha;
    } catch {
      return true;
    }
  });
  if (mismatched.length > 0) return blocked(`組のファイルが記録と違います（無い、または sha256 が違う）: ${mismatched.map(([rel]) => rel).join(", ")}`);
  if (performance.timeOrigin < Date.parse(harness.appliedAt)) return { kind: "stale", appliedAt: harness.appliedAt };
  return { kind: "ok", harness };
}

// 形が正しければ記録を、正しくなければ理由を返す
function parseHarness(raw: unknown): Harness | string {
  if (typeof raw !== "object" || raw === null) return "オブジェクトではありません";
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
  if (r.version !== 1) return `version が 1 ではありません: ${String(r.version)}`;
  if (typeof r.appliedAt !== "string" || Number.isNaN(Date.parse(r.appliedAt))) return "appliedAt が時刻ではありません";
  const pin = r.pin as Record<string, unknown> | null | undefined;
  if (typeof pin?.commit !== "string") return "pin.commit がありません";
  for (const key of ["content", "control"] as const) {
    if (typeof r[key] !== "string" || !isAbsolute(r[key])) return `${key} が絶対パスではありません`;
  }
  if (!strings(r.skillDirectories) || r.skillDirectories.length === 0 || !r.skillDirectories.every((dir) => isAbsolute(dir))) {
    return "skillDirectories が絶対パスの配列ではありません";
  }
  if (!strings(r.manualSkills) || r.manualSkills.length === 0) return "manualSkills が名前の配列ではありません";
  const files = r.files as Record<string, unknown> | null | undefined;
  if (typeof files !== "object" || files === null || Object.keys(files).length === 0) return "files がありません";
  for (const [rel, sha] of Object.entries(files)) {
    if (isAbsolute(rel) || normalize(rel).startsWith("..") || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return `files の項目 ${rel} が写しの中の相対パスと sha256 ではありません`;
    }
  }
  return raw as Harness;
}

// 実行時の層に読み込みの設定を書く。どれも、いまの実効値（global・project・--config を合わせたもの）を土台にする。
// 値が既に同じなら書かない（子と孫の factory で呼ばれたとき、設定の変更を知らせる仕組みを無駄に動かさない）
function overrideSettings(settings: Settings, harness: Harness): void {
  const handle = (id: string) => {
    const setting = lookup(id);
    if (setting === undefined) throw new Error(`OMP の設定 ${id} がありません`);
    const value = setting.get(settings);
    const current = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
    const override = (next: string[]) => {
      if (next.length !== current.length || next.some((entry, i) => entry !== current[i])) setting.override(settings, next);
    };
    return { current, override };
  };
  const extensions = handle("extensions");
  const customDirectories = handle("skills.customDirectories");
  const manualSkills = handle("skills.manualSkills");
  const disabledExtensions = handle("disabledExtensions");
  const ours = new Set([real(harness.content), real(harness.control)]);
  const skillDirs = new Set(harness.skillDirectories.map(real));
  const skillIds = new Set(harness.manualSkills.map((name) => `skill:${name}`));

  // OMP 向けのディレクトリ（content）を足す。この拡張（control）も残す
  const nextExtensions = [...extensions.current];
  for (const dir of [harness.control, harness.content]) {
    if (!nextExtensions.some((entry) => real(entry) === real(dir))) nextExtensions.push(dir);
  }
  extensions.override(nextExtensions);
  // 生成したスキルの置き場を先頭に置く（custom 同士は先が勝つので、pstack の tdd が利用者の置き場の tdd より優先される）
  customDirectories.override([...harness.skillDirectories, ...customDirectories.current.filter((entry) => !skillDirs.has(real(entry)))]);
  // 読み込むスキルをすべて一覧から外す（名前で呼べば使える）
  manualSkills.override([...manualSkills.current, ...harness.manualSkills.filter((name) => !manualSkills.current.includes(name))]);
  // 組の置き場と、読み込むスキル（skill:<名前>）を無効にする指定を外す
  disabledExtensions.override(disabledExtensions.current.filter((entry) => !ours.has(real(entry)) && !skillIds.has(entry)));
}

// worker thread の子の設定は、親（メインのスレッド）の設定の写し（mirror）か、その上に重ねた層である
function isMirror(settings: Settings): boolean {
  for (let scope: Settings | undefined = settings; scope !== undefined; scope = scope.overlayParent?.()) {
    if (scope.isMirror === true) return true;
  }
  return false;
}

// 同じディレクトリの別名（macOS の /tmp と /private/tmp、~ など）を同じとみなすための形
function real(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function report(ctx: ExtensionContext, message: string, type: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else process.stderr.write(`${message}\n`);
}
