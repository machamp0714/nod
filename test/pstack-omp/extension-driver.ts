// 制御の拡張（適用した写しの control/index.ts）を、OMP の代わりに読み込んで動かすテスト用のプロセス。
// OMP と同じく、拡張はプロセスごとに1度読み込まれ、セッションごとに factory が呼ばれて待たれ、その後に session_start が届く。
// 子のセッションは親の実行時の層を引き継ぐので、全セッションで1つの偽の設定を共有する。
// 偽の設定は、OMP 19.1.0 の層の合わせ方を写す（Document 1683 の論点 2、補遺 Document 1717 の論点 E・G の #mergeOwnLayers・#deepMerge・
// grantAuthority・#readConfigOverlays）:
// - 層は下から global（シナリオの settings）・project・設定の重ね・実行時の上書き。設定の重ねは、環境変数 PI_CONFIG_FILES のファイル、
//   専用ランチャーが --config で渡すファイル（偽の omp が FAKE_OMP_CONFIG に入れる）、シナリオの configFiles（利用者の --config）の順に
//   YAML として読んで合わせる（getConfigFiles はこの順の一覧）。
// - merge が prepend の設定（bash.patterns）は、上の層の空でない配列を下の層の前に足し、上の層の空の配列は下の層を消す。ほかの配列と値は
//   上の層が置き換え、record はキーごとに上の層が勝つ。実行時の上書きは丸ごと置き換える。
// - 運用者の見え方（grantAuthority）は project の層を除いて合わせる。
// 拡張の外から見える結果（実行時の上書きとその時点、session_start の前の実効値、bash.patterns の2つの見え方、登録した renderer、
// tool_call と before_subagent_spawn の戻り値、知らせ、worker thread の子に渡る環境変数）だけを JSON で標準出力に出す。
// 使い方: bun extension-driver.ts <拡張の index.ts>。標準入力にシナリオの JSON を書いて閉じると動き出す
// （プロセスの開始を再適用の前にしたいテストが、起動してから再適用できるように）。
// シナリオの形は helpers.ts の ExtensionScenario、出す結果の形は ExtensionResult。
import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { isRecord } from "../../omp/control/rules";
import { HARNESS_ENV, type ExtensionScenario } from "./helpers";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Phase = "factory" | "session_start" | "tool_call";
type Raw = Record<string, unknown>;

// OMP の Settings の代わり。どれも同じ層を読み、authority なら運用者の見え方（project を除く）。
// overlayParent は OMP の Settings と同じく、重なっている下の設定を返す（worker thread の子では、メインのスレッドの設定の写し）
interface Scope {
  authority: boolean;
  isMirror?: boolean;
  overlayParent(): Scope | undefined;
  grantAuthority?(): Scope;
  getConfigFiles(): readonly string[];
}

const overrides: { id: string; value: unknown; session: number; phase: Phase }[] = [];
const notices: string[] = [];
let current = { session: 0, phase: "factory" as Phase };
// 制御の拡張が使う設定と既定値
const DEFAULTS: Record<string, unknown> = {
  extensions: [],
  disabledExtensions: [],
  "skills.customDirectories": [],
  "skills.manualSkills": [],
  "tools.approval": {},
  "bash.patterns": [],
};
// 配列の merge の戦略が prepend の設定（OMP の src/exec/settings.ts の bash.patterns）
const PREPEND: Record<string, true> = { "bash.patterns": true };
const layers = { global: {} as Raw, project: {} as Raw, overlay: {} as Raw, runtime: {} as Raw, files: [] as string[] };
let baseProvenance = "global";

// 上の層の値 higher を下の層の値 lower に合わせる（#deepMerge の combine と layer。bash.patterns の既定は空なので、下に無いときは上の値）
function merge(id: string, lower: unknown, higher: unknown): unknown {
  if (higher === undefined) return lower;
  if (isRecord(higher) && isRecord(lower)) return { ...lower, ...higher };
  if (PREPEND[id] && Array.isArray(higher) && higher.length > 0 && Array.isArray(lower)) return [...higher, ...lower];
  return higher;
}

// 実効値。authority なら運用者の見え方（project の層を除く）。実行時の上書きは丸ごと置き換える
function value(id: string, authority: boolean): unknown {
  if (id in layers.runtime) return layers.runtime[id];
  let merged = layers.global[id];
  if (!authority) merged = merge(id, merged, layers.project[id]);
  merged = merge(id, merged, layers.overlay[id]);
  return merged ?? DEFAULTS[id];
}

// 設定の重ねのファイルを YAML として読み、制御の拡張が使う設定の id ごとの値にする
function readOverlay(file: string): Raw {
  const parsed: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
  const values: Raw = {};
  for (const id of Object.keys(DEFAULTS)) {
    let at: unknown = parsed;
    for (const segment of id.split(".")) at = isRecord(at) ? at[segment] : undefined;
    if (at !== undefined) values[id] = at;
  }
  return values;
}

function scope(authority: boolean, parent: Scope | undefined, withAuthority: boolean, isMirror = false): Scope {
  const self: Scope = { authority, overlayParent: () => parent, getConfigFiles: () => [...layers.files] };
  if (isMirror) self.isMirror = true;
  if (withAuthority) self.grantAuthority = () => scope(true, undefined, false);
  return self;
}

Bun.plugin({
  name: "fake-omp-registry",
  setup(build) {
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
      loader: "object",
      exports: {
        lookup(id: string) {
          if (!(id in DEFAULTS)) return undefined;
          return {
            get: (at: Scope) => value(id, at.authority),
            // 値がどの層から来たか（実行時の上書きなら runtime）
            provenance: () =>
              id in layers.runtime ? "runtime" : id in layers.overlay ? "overlay" : id in layers.project ? "project" : id in layers.global ? baseProvenance : "default",
            override: (_at: Scope, next: unknown) => {
              layers.runtime[id] = next;
              overrides.push({ id, value: next, ...current });
            },
          };
        },
      },
    }));
  },
});

const scenario = JSON.parse(await Bun.stdin.text()) as ExtensionScenario;
for (const [key, value] of Object.entries(scenario.env ?? {})) process.env[key] = value;
layers.global = scenario.settings;
layers.project = scenario.project ?? {};
layers.runtime = { ...scenario.runtime };
baseProvenance = scenario.provenance ?? "global";
layers.files = [...(process.env.PI_CONFIG_FILES?.split(delimiter).filter(Boolean) ?? []), ...(process.env.FAKE_OMP_CONFIG ? [process.env.FAKE_OMP_CONFIG] : []), ...(scenario.configFiles ?? [])];
for (const file of layers.files) {
  const overlay = readOverlay(file);
  for (const id of Object.keys(overlay)) layers.overlay[id] = merge(id, layers.overlay[id], overlay[id]);
}
const withAuthority = scenario.authority !== false;
const settings = scope(false, scenario.mirror === true ? scope(false, undefined, withAuthority, true) : undefined, withAuthority);
// 拡張のパスは実行時に渡される（適用した写しの中）。偽のモジュールを登録した後に読み込む必要もある
const extension = (await import(process.argv[2]!)).default as (pi: unknown) => void | Promise<void>;
const effectiveNow = () => Object.fromEntries(Object.keys(DEFAULTS).map((id) => [id, value(id, false)]));
const toolCalls: unknown[][] = [];
const spawns: unknown[][] = [];
const effectiveAtStart: unknown[] = [];
const renderers: string[][] = [];
for (const [index, session] of scenario.sessions.entries()) {
  const handlers = new Map<string, Handler[]>();
  const registered: string[] = [];
  current = { session: index, phase: "factory" };
  await extension({
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerMessageRenderer: (customType: string) => registered.push(customType),
    pi: { settings },
  });
  renderers.push(registered);
  effectiveAtStart.push(effectiveNow());
  const ctx = { agent: session.agent ?? undefined, hasUI: true, cwd: scenario.cwd ?? process.cwd(), ui: { notify: (message: string) => notices.push(message) } };
  current = { session: index, phase: "session_start" };
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  Object.assign(layers.runtime, session.runtime);
  current = { session: index, phase: "tool_call" };
  const calls = typeof session.toolCalls === "number" ? Array.from({ length: session.toolCalls }, () => ({ toolName: "bash", input: { command: "ls" } })) : session.toolCalls;
  const results: unknown[] = [];
  for (const [i, call] of calls.entries()) {
    let result: unknown;
    for (const handler of handlers.get("tool_call") ?? []) result ??= await handler({ type: "tool_call", toolCallId: `t${i}`, ...call }, ctx);
    results.push(result ?? null);
  }
  toolCalls.push(results);
  const spawned: unknown[] = [];
  for (const agent of session.spawns ?? []) {
    let result: unknown;
    for (const handler of handlers.get("before_subagent_spawn") ?? []) result ??= await handler({ type: "before_subagent_spawn", agent, invocationKind: "task" }, ctx);
    spawned.push(result ?? null);
  }
  spawns.push(spawned);
}
const patterns = { session: value("bash.patterns", false), authority: withAuthority ? value("bash.patterns", true) : null };
console.log(JSON.stringify({ overrides, effective: effectiveNow(), patterns, effectiveAtStart, renderers, toolCalls, spawns, notices, harnessEnv: process.env[HARNESS_ENV] ?? null }));
