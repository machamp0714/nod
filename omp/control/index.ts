// pstack を OMP で使う組の制御の拡張。適用（scripts/pstack-omp/cli.ts apply）が nod のデータ置き場の pstack-omp/omp/control に写し、
// 利用者の OMP の設定（config.yml）に3つの読み込みの設定（extensions にこのファイル（control/index.ts）と OMP 向けのディレクトリ content、
// skills.customDirectories の先頭に写しの中の生成したスキルの置き場、skills.manualSkills に読み込む全スキル）を入れる。
// このファイルをディレクトリではなくファイルのパスで書くのは、OMP が設定に書いたファイルの拡張を disabledExtensions で外さないため。
// 写しの起動の入口（bin/omp）も omp に -e でこのファイルを渡す（プロジェクトの設定が extensions を置き換えても読まれるように）。
// 読み込みの設定は同じ写しの harness.json（適用が書く組の記録）から、禁止操作を止める規則は同じ写しの rules.json
// （nod のリポジトリの omp/control/rules.json。形は rules.ts）から読む。写しは作業中のリポジトリや clone の外の置き場で、
// 生成したスキル・規則・起動の入口（bin/omp）・サンドボックスのプロファイル（control/sandbox.sb）を含む写しの全ファイルを組の記録の sha256 で確かめる。
// 信頼境界は macOS のサンドボックス（Seatbelt）。写しの起動の入口から起動した OMP とその子孫は、規則の守る集合（写し・生成物・clone、
// OMP の設定、利用者のエージェント定義と拡張とプラグインの置き場、omp の実行ファイルと、それらの祖先）と、どのプロジェクトでも
// プロジェクトの設定と同じプロセスで動くコードの置き場（規則の projectPaths。.omp/ など）に書けない（カーネルが拒否し、中から外せない）。
// 写しは読み取り専用にしない（同じ利用者の chmod で戻せるので守りにならない）。
//
// - 組の記録と規則を検証する（読める、形が正しい、指すディレクトリが写しの中にある、組の各ファイルの sha256 が記録と同じ、files に規則が
//   入っている、規則の形が正しい）。続けて、このプロセスが守る集合と作業ディレクトリの下の projectPaths に書けないこと（サンドボックスに
//   閉じ込められていること）を試して確かめる（writable）。最後に OMP の設定のモジュールを読む。どれかが通らなければ、メインでも子でも
//   全ツールと子の起動を遮断し、理由を返す。
//   読み込みの設定も規則も入れない（新しい構成のまま、読み込み先や規則が壊れた・書き換えられる状態でツールを使わせない）。
// - 正しければ、拡張の読み込み（factory）で、config.yml と同じ読み込みの設定と規則の上書きを同じ処理で実行時の層（永続しない。global・
//   project・--config より強く、OMP の運用者の層にも入るのでプロジェクトの設定では緩められない）にも書く。固定するキーは extensions・
//   disabledExtensions・skills.customDirectories・skills.manualSkills・tools.approval・bash.patterns。値が同じでも実行時の層から来ていなければ書く
//   （config.yml の書き換えや --config・プロジェクトの層で、実行中に変わらないように）。
//   セッションの開始（session_start）より前に書くのは、メインの task ツールが作られるときにエージェント定義を探すので、
//   そのときまでに OMP 向けのディレクトリ（content）が extensions に入っていないと、メインの task の一覧に poteto-agent が出ないため。
//   factory はセッションごと（子と孫も）に呼ばれ、同じプロセスの子と孫は親と同じ設定を使うので、同じ値なら書き直さない。
// - worker thread の写し（mirror）の設定には書かない（親の設定を写したもので、親が既に書いている）。worker thread はこの拡張を
//   ディスクから読み直すので、同じ検証をし直し、さらにメインのスレッドが検証した組の記録の sha256（環境変数で渡す）と同じかを確かめる。
//   実行中にディスクの組や規則が変わっていれば遮断する。
// - tool_call では、規則のうち構造化された引数だけを検査する（github の op、task の isolated と子と孫が起動するエージェント、
//   書き込みのツールのパス）。シェルの中身は解釈しない（bash は OMP の bash.patterns の deny が止める）。子と孫かどうかは、
//   モデルが渡す引数ではなく実行基盤の ctx.agent で見分ける。子の起動は before_subagent_spawn でも同じく検査する。
// - TUI は、providers・shortcuts・renderer などを何も登録しない拡張の読み込みを、入力欄の表示の後に回すことがある
//   （OMP の extensibility/extensions/startup-deferral.ts）。そうなると task ツールが作られた後に書くことになるので、
//   後回しにさせないため、customType が pstack-omp の message renderer を登録する（この拡張はその種類のメッセージを送らない）。
// - このプロセスが適用より前に始まっていたら（適用より前のセッションに、後から読み込まれたとき）、組を検証せず何もしない（上書きも遮断もしない）。
//   新しいセッションから効く。適用より前のプロセスは新しい構成を読まないので、config.yml の読み直しなどで壊れた・入れ替え中の組を
//   たまたま読んでも、利用者や親のセッションのツールを止めない。適用の時刻は、組が壊れていても決められる方法で求める（applyTime）。
// 検証はプロセス（worker thread ではスレッド）で1度だけ行い、同じプロセスの全セッション（メイン・子・孫）で同じ結果を使う。
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Settings, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { guarded, type Guarded, isRecord, parseRules, realAncestor, resolvePlaces, type Rules } from "./rules";

// OMP の設定を引く関数（OMP の config/registry の lookup）
type Lookup = (id: string) => Setting | undefined;

const HERE = import.meta.dir;
// 写しの根（content/ と control/ を持つ）
const ROOT = dirname(HERE);
const HARNESS = join(HERE, "harness.json");
const RULES = "control/rules.json";
const NAME = "pstack-omp";
// メインのスレッドが検証した組の記録の sha256 を、worker thread の子に渡す環境変数
const HARNESS_ENV = "NOD_PSTACK_OMP_HARNESS_SHA256";
// パスを引数に持つ書き込みのツール
const WRITE_TOOLS = ["write", "edit", "apply_patch", "ast_edit"];

// 組の記録のうち、この拡張が使う部分
interface Harness {
  appliedAt: string;
  pin: { commit: string };
  content: string;
  control: string;
  agentDir: string;
  ompBin: string;
  skillDirectories: string[];
  manualSkills: string[];
  // 写しの根からの相対パス → sha256
  files: Record<string, string>;
}

// 検証した組と規則。置き場のプレースホルダは解決済み
interface Control {
  harness: Harness;
  rules: Rules;
  harnessSha: string;
  bashDeny: string[];
  // 書き込みのツールで書けない置き場（守る集合の実パス）
  protectedPaths: string[];
  lookup: Lookup;
}

type Verdict = { kind: "ok"; control: Control } | { kind: "blocked"; reason: string } | { kind: "stale"; appliedAt: string };

let verdict: Verdict | undefined;

export default async function control(pi: ExtensionAPI): Promise<void> {
  const mirror = isMirror(pi.pi.settings);
  verdict ??= await judge(mirror);
  pi.registerMessageRenderer(NAME, (message) => ({ render: () => [String(message.content)], invalidate: () => {} }));
  const current = verdict;
  if (current.kind === "ok" && !mirror) {
    try {
      overrideSettings(pi.pi.settings, current.control);
      process.env[HARNESS_ENV] = current.control.harnessSha;
    } catch (e) {
      verdict = blocked(`読み込みの設定と規則を書けませんでした: ${(e as Error).message}`);
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
    const { harness, rules, bashDeny } = current.control;
    report(
      ctx,
      `${NAME}: 適用（${harness.appliedAt}、pin ${harness.pin.commit.slice(0, 12)}）の組を読み込みました（一覧から外すスキル ${harness.manualSkills.length} 個。` +
        `規則 版 ${rules.version}: 拒否するツール ${Object.keys(rules.toolApproval).join(", ")}、bash の拒否のパターン ${bashDeny.length} 個）`,
      "info",
    );
  });

  pi.on("tool_call", (event, ctx) => {
    const current = verdict!;
    if (current.kind === "blocked") return { block: true, reason: `${NAME}: ${current.reason}` };
    if (current.kind === "stale") return undefined;
    return inspect(event, ctx, current.control);
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const current = verdict!;
    if (current.kind === "blocked") return { block: true, reason: `${NAME}: ${current.reason}` };
    if (current.kind === "stale") return undefined;
    return checkAgent(typeof event.agent === "string" ? event.agent : undefined, ctx, current.control.rules);
  });
}

function blocked(reason: string, advice = `組（${ROOT}）が正しくないので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください`): Extract<Verdict, { kind: "blocked" }> {
  return { kind: "blocked", reason: `${reason}。${advice}` };
}

async function judge(mirror: boolean): Promise<Verdict> {
  const appliedAt = applyTime();
  if (appliedAt !== undefined && performance.timeOrigin < appliedAt) return { kind: "stale", appliedAt: new Date(appliedAt).toISOString() };
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = readFileSync(HARNESS);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return blocked(`組の記録 ${HARNESS} を読めません: ${(e as Error).message}`);
  }
  const harness = parseHarness(raw);
  if (typeof harness === "string") return blocked(`組の記録 ${HARNESS} の形が正しくありません: ${harness}`);
  if (real(harness.control) !== real(HERE)) return blocked(`組の記録の control（${harness.control}）がこの拡張の置き場（${HERE}）と違います`);
  for (const dir of [harness.content, ...harness.skillDirectories]) {
    if (!isDirectory(dir)) return blocked(`組の記録が指すディレクトリ ${dir} がありません`);
    // 読み込む中身は写しの中だけ（各ファイルを files の sha256 で確かめる）
    if (!real(dir).startsWith(`${real(ROOT)}/`)) return blocked(`組の記録が指すディレクトリ ${dir} が写し（${ROOT}）の外です`);
  }
  if (!(RULES in harness.files)) return blocked(`組の記録の files に規則 ${RULES} がありません`);
  const mismatched = Object.entries(harness.files).filter(([rel, sha]) => {
    try {
      return sha256(readFileSync(join(ROOT, rel))) !== sha;
    } catch {
      return true;
    }
  });
  if (mismatched.length > 0) return blocked(`組のファイルが記録と違います（無い、または sha256 が違う）: ${mismatched.map(([rel]) => rel).join(", ")}`);
  let rules: Rules | string;
  try {
    rules = parseRules(JSON.parse(readFileSync(join(ROOT, RULES), "utf8")));
  } catch (e) {
    rules = `読めません: ${(e as Error).message}`;
  }
  if (typeof rules === "string") return blocked(`規則 ${join(ROOT, RULES)} が正しくありません: ${rules}`);
  const harnessSha = sha256(bytes);
  const expected = process.env[HARNESS_ENV];
  if (mirror && expected !== undefined && expected !== harnessSha) {
    return blocked(`組の記録 ${HARNESS} が、メインのスレッドが検証したものと違います（実行中に組が変わった）`);
  }
  // 検証の前に適用の時刻を求められず（入れ替え中）、その後に組が読めたとき
  if (performance.timeOrigin < Date.parse(harness.appliedAt)) return { kind: "stale", appliedAt: harness.appliedAt };
  const places = { agentDir: harness.agentDir, workDir: realAncestor(dirname(ROOT)), ompBin: harness.ompBin, home: homedir() };
  const guard = guarded(rules, places);
  const open = writable(guard, real(process.cwd()));
  if (open.length > 0) {
    return blocked(
      `サンドボックスの外で起動しています（このプロセスから書けてしまう置き場: ${open.join(", ")}）`,
      `${join(realAncestor(ROOT), "bin", "omp")} から起動してください。閉じ込められていないので、ツールを実行しません`,
    );
  }
  let lookup: Lookup;
  try {
    // OMP の非公開のモジュール。静的に読むと、OMP の更新で無くなったときに拡張ごと読み込みに失敗し、制御だけが欠けた構成が残るので、ここで読む
    ({ lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry"));
    if (typeof lookup !== "function") throw new Error("lookup がありません");
  } catch (e) {
    return blocked(
      `OMP の設定のモジュール（@oh-my-pi/pi-coding-agent/config/registry）を読めません: ${(e as Error).message}`,
      "OMP の版が固定の記録と違う可能性があるので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめてください",
    );
  }
  return {
    kind: "ok",
    control: {
      harness,
      rules,
      harnessSha,
      bashDeny: rules.bashDeny.map((match) => resolvePlaces(match, places)),
      protectedPaths: guard.paths.map(({ path }) => path),
      lookup,
    },
  };
}

// 守る集合と、作業ディレクトリ（cwd、実パス）の下のどのプロジェクトでも書かせないパスのうち、このプロセスが書けてしまう置き場
// （閉じ込められていれば空）。FFI は使わず、拒否されるかを試す。
// - 在るファイルは、書き込みで開くこと（開けたら書かずに閉じる）と同じ mode への chmod。在るディレクトリは、同じ mode への chmod と、
//   守る集合ならその中への mkdir（作れたら消す）。祖先は、同じ mode への chmod。どれも EPERM（サンドボックスの拒否）で失敗しなければ
//   書けるとみなす。EACCES などの mode の拒否は、同じ利用者の chmod で戻せるので閉じ込めとみなさない。
// - 無いパス（祖先を除く）は、親が在れば作ってみる（ディレクトリは mkdir、ファイルは O_CREAT|O_EXCL で開く）。EPERM か EACCES で失敗し、
//   無いままなら書けない。作れてしまったら消して書けるとみなす。ほかの失敗も書けるとみなす。親が無ければ試さない。
// 試しで作るものは、この拡張のディレクトリの中には作らない（適用の時刻 applyTime を変えないため）
function writable({ paths, ancestors, projects }: Guarded, cwd: string): string[] {
  const here = real(HERE);
  const inHere = (path: string) => path === here || path.startsWith(`${here}/`);
  const denied = (attempt: () => void): boolean => {
    try {
      attempt();
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const create = (path: string, directory: boolean): boolean => {
    if (!existsSync(dirname(path)) || inHere(dirname(path))) return false;
    try {
      if (directory) mkdirSync(path);
      else closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return !((code === "EPERM" || code === "EACCES") && !existsSync(path));
    }
    rmSync(path, { recursive: true, force: true });
    return true;
  };
  const probe = (path: string, directory: boolean, kind: "guard" | "project" | "ancestor"): boolean => {
    let mode: number;
    let isDirectory: boolean;
    try {
      const stat = statSync(path);
      mode = stat.mode & 0o7777;
      isDirectory = stat.isDirectory();
    } catch (e) {
      return kind !== "ancestor" && (e as NodeJS.ErrnoException).code === "ENOENT" && create(path, directory);
    }
    const chmod = () => chmodSync(path, mode);
    if (kind === "ancestor") return !denied(chmod);
    if (!isDirectory) return !denied(() => closeSync(openSync(path, constants.O_WRONLY | constants.O_APPEND))) || !denied(chmod);
    if (!denied(chmod)) return true;
    if (kind === "project" || inHere(path)) return false;
    return !denied(() => {
      const dir = join(path, `.pstack-omp-probe-${randomBytes(6).toString("hex")}`);
      mkdirSync(dir);
      rmSync(dir, { recursive: true, force: true });
    });
  };
  return [
    ...paths.filter(({ path, directory }) => probe(path, directory, "guard")).map(({ path }) => path),
    ...ancestors.filter((path) => probe(path, true, "ancestor")),
    ...projects.map(({ path, directory }) => ({ path: join(cwd, path), directory })).filter(({ path, directory }) => probe(path, directory, "project")).map(({ path }) => path),
  ];
}

// 適用の時刻（ミリ秒）。組の検証より前に、組が壊れていても決められる方法で求める。組の記録の appliedAt が時刻として読めればそれ。
// 読めなければ、この拡張のディレクトリ（HERE）の作られた時刻と最後に変わった時刻の新しい方。適用は appliedAt を決めてから、
// このディレクトリを一時ディレクトリの中に作って harness.json を書き、置き換えるので、どちらの時刻も適用の時刻以上になる。
// ディレクトリも無ければ（入れ替え中）undefined
function applyTime(): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(HARNESS, "utf8"));
    const recorded = isRecord(raw) && typeof raw.appliedAt === "string" ? Date.parse(raw.appliedAt) : Number.NaN;
    if (!Number.isNaN(recorded)) return recorded;
  } catch {
    // 組の記録が無い・読めない。ディレクトリの時刻を使う
  }
  try {
    const stat = statSync(HERE);
    return Math.max(stat.birthtimeMs, stat.mtimeMs);
  } catch {
    return undefined;
  }
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
  for (const key of ["content", "control", "agentDir", "ompBin"] as const) {
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

// 実行時の層に、読み込みの設定と規則の上書きを同じ処理で書く。どれも、いまの実効値（global・project・--config と、前に書いた実行時の層を
// 合わせたもの）を土台にし、何度計算しても同じ値になるようにする。全部の設定を見つけてから書く（片方だけが入る経路を作らない）。
// 値が同じで、既に実行時の層から来ていれば書かない（子と孫の factory で呼ばれたとき、設定の変更を知らせる仕組みを無駄に動かさない）
function overrideSettings(settings: Settings, { harness, rules, bashDeny, lookup }: Control): void {
  const handle = (id: string) => {
    const setting = lookup(id);
    if (setting === undefined) throw new Error(`OMP の設定 ${id} がありません`);
    const value = setting.get(settings);
    const write = (next: unknown) => {
      if (setting.provenance(settings) !== "runtime" || JSON.stringify(next) !== JSON.stringify(value)) setting.override(settings, next);
    };
    return { value, write };
  };
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);
  const extensions = handle("extensions");
  const customDirectories = handle("skills.customDirectories");
  const manualSkills = handle("skills.manualSkills");
  const disabledExtensions = handle("disabledExtensions");
  const approval = handle("tools.approval");
  const patterns = handle("bash.patterns");
  const ours = new Set([real(harness.content), real(harness.control)]);
  const skillDirs = new Set(harness.skillDirectories.map(real));
  const skillIds = new Set(harness.manualSkills.map((name) => `skill:${name}`));
  const manual = strings(manualSkills.value);
  const denies = new Set(bashDeny.map(collapse));

  // OMP 向けのディレクトリ（content）を足す。この拡張のファイル（config.yml と同じく、ディレクトリではなくファイルのパス）も残す
  const nextExtensions = strings(extensions.value);
  for (const entry of [join(harness.control, "index.ts"), harness.content]) {
    if (!nextExtensions.some((existing) => real(existing) === real(entry))) nextExtensions.push(entry);
  }
  const writes: [typeof extensions, unknown][] = [
    [extensions, nextExtensions],
    // 生成したスキルの置き場を先頭に置く（custom 同士は先が勝つので、pstack の tdd が利用者の置き場の tdd より優先される）
    [customDirectories, [...harness.skillDirectories, ...strings(customDirectories.value).filter((entry) => !skillDirs.has(real(entry)))]],
    // 読み込むスキルをすべて一覧から外す（名前で呼べば使える）
    [manualSkills, [...manual, ...harness.manualSkills.filter((name) => !manual.includes(name))]],
    // 組の置き場と、読み込むスキル（skill:<名前>）を無効にする指定を外す
    [disabledExtensions, strings(disabledExtensions.value).filter((entry) => !ours.has(real(entry)) && !skillIds.has(entry))],
    // 規則のツールの拒否で、同じキーを上書きする（ほかのキーは保つ）
    [approval, { ...(isRecord(approval.value) ? approval.value : {}), ...rules.toolApproval }],
    // 規則の deny を先頭に置く（OMP はパターンを先から照合し、最初に当たったものを使うことがあるので、利用者の allow より先にする）。
    // いまの実効値からは、規則と同じ deny を除いて後ろに残す
    [
      patterns,
      [
        ...bashDeny.map((match) => ({ match, approval: "deny" })),
        ...(Array.isArray(patterns.value) ? patterns.value : []).filter((p) => !(isRecord(p) && p.approval === "deny" && typeof p.match === "string" && denies.has(collapse(p.match)))),
      ],
    ],
  ];
  for (const [setting, next] of writes) setting.write(next);
}

// 規則のうち、構造化された引数で決まるものを検査する。拒否するなら理由を返す
function inspect(event: ToolCallEvent, ctx: ExtensionContext, { rules, protectedPaths }: Control): ToolCallEventResult | undefined {
  const input = isRecord(event.input) ? event.input : {};
  if (event.toolName === "github") {
    if (typeof input.op === "string" && rules.github.denyOps.includes(input.op)) {
      return { block: true, reason: `${NAME}: github の ${input.op} は、この組では拒否します（push と PR の作成はしない）` };
    }
    return undefined;
  }
  if (event.toolName === "task") {
    // task.batch では tasks の各項目、そうでなければ呼び出しそのものが1つの子
    const items = Array.isArray(input.tasks) ? input.tasks.filter(isRecord) : [input];
    for (const item of items) {
      if (rules.task.denyIsolated && item.isolated === true) {
        return { block: true, reason: `${NAME}: task の isolated: true は、この組では拒否します（clone の .omp/extensions が読まれうるため）` };
      }
      const denied = checkAgent(typeof item.agent === "string" ? item.agent : undefined, ctx, rules);
      if (denied !== undefined) return denied;
    }
    return undefined;
  }
  if (!WRITE_TOOLS.includes(event.toolName)) return undefined;
  for (const path of writtenPaths(input)) {
    const target = protectedTarget(path, ctx.cwd, protectedPaths);
    if (target !== undefined) return { block: true, reason: `${NAME}: ${event.toolName} で ${target} には書けません（OMP の設定と pstack-omp の組を、実行中のセッションから変えさせない）` };
  }
  return undefined;
}

// 子と孫（実行基盤の ctx.agent が main でないもの）が起動できるのは、規則のエージェントだけ。名前を省けば既定の task
function checkAgent(agent: string | undefined, ctx: ExtensionContext, rules: Rules): ToolCallEventResult | undefined {
  if (ctx.agent?.kind === "main") return undefined;
  const name = (agent ?? "task").toLowerCase();
  if (rules.task.subAgents.some((allowed) => allowed.toLowerCase() === name)) return undefined;
  return { block: true, reason: `${NAME}: 子と孫が起動できるエージェントは ${rules.task.subAgents.join(", ")} だけです（${agent} は起動しません）` };
}

// 書き込みのツールの引数のうち、書き込む先のパス（write・edit の path、ast_edit の paths、edit の input のファイルの見出しと移動先）
function writtenPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(unwrap(input.path));
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p): p is string => typeof p === "string"));
  if (typeof input.input === "string") {
    for (const line of input.input.split("\n")) {
      const text = line.trim();
      const header = /^\[(.+)\]$/.exec(text)?.[1];
      const moved = /^MV\s+(.+)$/.exec(text)?.[1];
      const patched = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(text)?.[1];
      if (header !== undefined) paths.push(unwrap(`[${header}]`));
      if (moved !== undefined) paths.push(moved.replace(/^(["'])(.*)\1$/, "$2"));
      if (patched !== undefined) paths.push(patched.trim());
    }
  }
  return paths;
}

// [パス#TAG] の形からパスを取り出す
function unwrap(path: string): string {
  const inner = /^\[(.+)\]$/.exec(path.trim())?.[1];
  return inner === undefined ? path : inner.replace(/#[0-9A-Za-z]+$/, "");
}

// 書けない置き場に入るなら、その置き場を返す。内部の URL（local:// など）は見ない
function protectedTarget(path: string, cwd: string, protectedPaths: string[]): string | undefined {
  const plain = path.startsWith("file://") ? path.slice("file://".length) : path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(plain)) return undefined;
  const expanded = plain === "~" || plain.startsWith("~/") ? join(homedir(), plain.slice(1)) : plain;
  const target = fold(realAncestor(resolve(cwd, expanded)));
  return protectedPaths.find((path) => {
    const dir = fold(path);
    return target === dir || target.startsWith(`${dir}/`) || target.startsWith(`${dir}:`);
  });
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

// macOS のファイルシステムは既定で大文字と小文字を区別しないので、比べるときは小文字にそろえる
function fold(path: string): string {
  return process.platform === "darwin" ? path.toLowerCase() : path;
}

// OMP の bash.patterns と同じく、前後の空白を除き、空白の並びを1つにする
function collapse(match: string): string {
  return match.trim().replace(/\s+/gu, " ");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
