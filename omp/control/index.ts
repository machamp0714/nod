// pstack を OMP で使う組の制御の拡張。適用（scripts/pstack-omp/cli.ts apply）が nod のデータ置き場の pstack-omp/omp/control に写す。
// 利用者の OMP の設定（config.yml）には何も書かない。写しの専用ランチャー（bin/omp）だけが、omp に -e でこのファイルを渡す
// （ランチャーを使わない通常の omp のセッションは、この拡張も pstack も読まない）。読み込みの設定は同じ写しの harness.json
// （適用が書く組の記録）から、禁止操作を止める規則は同じ写しの rules.json（nod のリポジトリの omp/control/rules.json。形は rules.ts）から読む。
// 信頼境界は macOS のサンドボックス（Seatbelt）。ランチャーから起動した OMP とその子孫は、規則の守る集合（写し・生成物・clone、
// OMP の設定、利用者のエージェント定義と拡張とプラグインの置き場、omp と bun の実行ファイルと、それらの祖先）と、どのプロジェクトでも
// プロジェクトの設定と同じプロセスで動くコードの置き場（規則の projectPaths。.omp/ など）に書けない（カーネルが拒否し、中から外せない）。
// 写しは読み取り専用にしない（同じ利用者の chmod で戻せるので守りにならない）。
//
// - 組を検証する（verify.ts。ランチャーが omp を起動する前に preflight.ts で行うものと同じ: 組の記録と写しの全ファイルの照合、規則の形、
//   OMP の設定の置き場、閉じ込めの試し）。続けて OMP の設定のモジュールを読む。どれかが通らなければ、メインでも子でも全ツールと子の起動を
//   遮断し、理由を返す。読み込みの設定も規則も入れない（読み込み先や規則が壊れた・書き換えられる状態で pstack を使わせない）。
//   適用の時刻では何も省かない（再適用の前後に始まったプロセスも、検証してから使う）。
// - 正しければ、拡張の読み込み（factory）で、3つの読み込みの設定（extensions にこのファイルと OMP 向けのディレクトリ content、
//   skills.customDirectories の先頭に写しの中の生成したスキルの置き場、skills.manualSkills に読み込む全スキル）と規則の上書きを、
//   利用者の設定の実効値を土台に、同じ処理で実行時の層（永続しない。global・project・--config より強く、OMP の運用者の層にも入るので
//   プロジェクトの設定では緩められない）に書く。固定するキーは extensions・disabledExtensions・skills.customDirectories・
//   skills.manualSkills・tools.approval・bash.patterns。値が同じでも実行時の層から来ていなければ書く（config.yml の書き換えや --config・
//   プロジェクトの層で、実行中に変わらないように）。
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
// 検証はプロセス（worker thread ではスレッド）で1度だけ行い、同じプロセスの全セッション（メイン・子・孫）で同じ結果を使う。
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Settings, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { isRecord, realAncestor, resolvePlaces, type Rules } from "./rules";
import { CONTROL_ENTRY, type Harness, LAUNCHER_FILE, real, verify } from "./verify";

// OMP の設定を引く関数（OMP の config/registry の lookup）
type Lookup = (id: string) => Setting | undefined;

const HERE = import.meta.dir;
// 写しの根（content/ と control/ を持つ）
const ROOT = dirname(HERE);
const NAME = "pstack-omp";
// メインのスレッドが検証した組の記録の sha256 を、worker thread の子に渡す環境変数
const HARNESS_ENV = "NOD_PSTACK_OMP_HARNESS_SHA256";
// パスを引数に持つ書き込みのツール
const WRITE_TOOLS = ["write", "edit", "apply_patch", "ast_edit"];

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

type Verdict = { kind: "ok"; control: Control } | { kind: "blocked"; reason: string };

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
    return inspect(event, ctx, current.control);
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const current = verdict!;
    if (current.kind === "blocked") return { block: true, reason: `${NAME}: ${current.reason}` };
    return checkAgent(typeof event.agent === "string" ? event.agent : undefined, ctx, current.control.rules);
  });
}

function blocked(reason: string, advice = `組（${ROOT}）が正しくないので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください`): Extract<Verdict, { kind: "blocked" }> {
  return { kind: "blocked", reason: `${reason}。${advice}` };
}

async function judge(mirror: boolean): Promise<Verdict> {
  const checked = verify(HERE, real(process.cwd()));
  if (checked.kind === "blocked") {
    return checked.confinement
      ? blocked(checked.reason, `${join(realAncestor(ROOT), LAUNCHER_FILE)} から起動してください。閉じ込められていないので、ツールを実行しません`)
      : blocked(checked.reason);
  }
  const expected = process.env[HARNESS_ENV];
  if (mirror && expected !== undefined && expected !== checked.harnessSha) {
    return blocked(`組の記録 ${join(HERE, "harness.json")} が、メインのスレッドが検証したものと違います（実行中に組が変わった）`);
  }
  let lookup: Lookup;
  try {
    // OMP の非公開のモジュール。静的に読むと、OMP の更新で無くなったときに拡張ごと読み込みに失敗するので、ここで読む
    ({ lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry"));
    if (typeof lookup !== "function") throw new Error("lookup がありません");
  } catch (e) {
    return blocked(
      `OMP の設定のモジュール（@oh-my-pi/pi-coding-agent/config/registry）を読めません: ${(e as Error).message}`,
      "OMP の版が固定の記録と違う可能性があるので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめてください",
    );
  }
  const { harness, rules, harnessSha, places, guard } = checked;
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

  // OMP 向けのディレクトリ（content）と、この拡張のファイル（子と孫のセッションも同じ拡張を読むように）を足す
  const nextExtensions = strings(extensions.value);
  for (const entry of [join(ROOT, CONTROL_ENTRY), harness.content]) {
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

// macOS のファイルシステムは既定で大文字と小文字を区別しないので、比べるときは小文字にそろえる
function fold(path: string): string {
  return process.platform === "darwin" ? path.toLowerCase() : path;
}

// OMP の bash.patterns と同じく、前後の空白を除き、空白の並びを1つにする
function collapse(match: string): string {
  return match.trim().replace(/\s+/gu, " ");
}

function report(ctx: ExtensionContext, message: string, type: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else process.stderr.write(`${message}\n`);
}
