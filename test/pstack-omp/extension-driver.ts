// 制御の拡張（適用した写しの control/index.ts）を、OMP の代わりに読み込んで動かすテスト用のプロセス。
// OMP と同じく、拡張はプロセスごとに1度読み込まれ、セッションごとに factory が呼ばれ、その後に session_start が届く。
// 子のセッションは親の実行時の層を引き継ぐので、全セッションで1つの偽の設定を共有する。
// 拡張の外から見える結果（実行時の上書きとその時点、session_start の前の実効値、登録した renderer、tool_call と before_subagent_spawn の戻り値、
// 知らせ、worker thread の子に渡る環境変数）だけを JSON で標準出力に出す。
// 使い方: bun extension-driver.ts <拡張の index.ts>。標準入力にシナリオの JSON を書いて閉じると動き出す
// （プロセスの開始を適用の前にしたいテストが、起動してから適用できるように）。
// シナリオの形は helpers.ts の ExtensionScenario、出す結果の形は ExtensionResult。
import { HARNESS_ENV, type ExtensionScenario } from "./helpers";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Phase = "factory" | "session_start" | "tool_call";

const overrides: { id: string; value: unknown; session: number; phase: Phase }[] = [];
const notices: string[] = [];
let current = { session: 0, phase: "factory" as Phase };
// OMP の実行時の層（override）は global・project より強い。ここでは override があればそれ、無ければ渡された実効値。
// overlayParent は OMP の Settings と同じく、重なっている下の設定を返す（worker thread の子では、メインのスレッドの設定の写し）
const settings = {
  base: {} as Record<string, unknown>,
  override: {} as Record<string, unknown>,
  overlayParent: (): { isMirror: boolean } | undefined => undefined,
};
// 制御の拡張が使う設定と既定値
const DEFAULTS: Record<string, unknown> = {
  extensions: [],
  disabledExtensions: [],
  "skills.customDirectories": [],
  "skills.manualSkills": [],
  "tools.approval": {},
  "bash.patterns": [],
};
let baseProvenance = "global";

Bun.plugin({
  name: "fake-omp-registry",
  setup(build) {
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
      loader: "object",
      exports: {
        lookup(id: string) {
          if (!(id in DEFAULTS)) return undefined;
          return {
            get: (scope: typeof settings) => (id in scope.override ? scope.override[id] : (scope.base[id] ?? DEFAULTS[id])),
            // 値がどの層から来たか（実行時の上書きなら runtime）
            provenance: (scope: typeof settings) => (id in scope.override ? "runtime" : id in scope.base ? baseProvenance : "default"),
            override: (scope: typeof settings, value: unknown) => {
              scope.override[id] = value;
              overrides.push({ id, value, ...current });
            },
          };
        },
      },
    }));
  },
});

const scenario = JSON.parse(await Bun.stdin.text()) as ExtensionScenario;
settings.base = scenario.settings;
baseProvenance = scenario.provenance ?? "global";
if (scenario.mirror === true) settings.overlayParent = () => ({ isMirror: true });
for (const [key, value] of Object.entries(scenario.env ?? {})) process.env[key] = value;
// 拡張のパスは実行時に渡される（適用した写しの中）。偽のモジュールを登録した後に読み込む必要もある
const extension = (await import(process.argv[2]!)).default as (pi: unknown) => void;
const effectiveNow = () => Object.fromEntries(Object.keys(DEFAULTS).map((id) => [id, id in settings.override ? settings.override[id] : (settings.base[id] ?? DEFAULTS[id])]));
const toolCalls: unknown[][] = [];
const spawns: unknown[][] = [];
const effectiveAtStart: unknown[] = [];
const renderers: string[][] = [];
for (const [index, session] of scenario.sessions.entries()) {
  const handlers = new Map<string, Handler[]>();
  const registered: string[] = [];
  current = { session: index, phase: "factory" };
  extension({
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerMessageRenderer: (customType: string) => registered.push(customType),
    pi: { settings },
  });
  renderers.push(registered);
  effectiveAtStart.push(effectiveNow());
  const ctx = { agent: session.agent ?? undefined, hasUI: true, cwd: scenario.cwd ?? process.cwd(), ui: { notify: (message: string) => notices.push(message) } };
  current = { session: index, phase: "session_start" };
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
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
console.log(JSON.stringify({ overrides, effective: effectiveNow(), effectiveAtStart, renderers, toolCalls, spawns, notices, harnessEnv: process.env[HARNESS_ENV] ?? null }));
