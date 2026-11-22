// 制御の拡張（適用した写しの control/index.ts）を、OMP の代わりに読み込んで動かすテスト用のプロセス。
// OMP と同じく、拡張はプロセスごとに1度読み込まれ、セッションごとに factory が呼ばれる。子のセッションは親の実行時の層を引き継ぐので、
// 全セッションで1つの偽の設定を共有する。拡張の外から見える結果（実行時の上書き、tool_call の戻り値、知らせ）だけを JSON で標準出力に出す。
// 使い方: bun extension-driver.ts <拡張の index.ts>。標準入力にシナリオの JSON を書いて閉じると動き出す
// （プロセスの開始を適用の前にしたいテストが、起動してから適用できるように）。
// シナリオの形は helpers.ts の ExtensionScenario、出す結果の形は ExtensionResult。
import type { ExtensionScenario } from "./helpers";

type Handler = (event: unknown, ctx: unknown) => unknown;

const overrides: { id: string; value: unknown }[] = [];
const notices: string[] = [];
// OMP の実行時の層（override）は global・project より強い。ここでは override があればそれ、無ければ渡された実効値
const settings = { base: {} as Record<string, unknown>, override: {} as Record<string, unknown> };
// 制御の拡張が使う設定（どれも文字列の配列で、既定は空）
const KNOWN = ["extensions", "disabledExtensions", "skills.customDirectories", "skills.manualSkills"];

Bun.plugin({
  name: "fake-omp-registry",
  setup(build) {
    build.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
      loader: "object",
      exports: {
        lookup(id: string) {
          if (!KNOWN.includes(id)) return undefined;
          return {
            get: (scope: typeof settings) => (id in scope.override ? scope.override[id] : (scope.base[id] ?? [])),
            override: (scope: typeof settings, value: unknown) => {
              scope.override[id] = value;
              overrides.push({ id, value });
            },
          };
        },
      },
    }));
  },
});

const scenario = JSON.parse(await Bun.stdin.text()) as ExtensionScenario;
settings.base = scenario.settings;
// 拡張のパスは実行時に渡される（適用した写しの中）。偽のモジュールを登録した後に読み込む必要もある
const extension = (await import(process.argv[2]!)).default as (pi: unknown) => void;
const toolCalls: unknown[][] = [];
for (const session of scenario.sessions) {
  const handlers = new Map<string, Handler[]>();
  extension({ on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]), pi: { settings } });
  const ctx = { agent: session.agent ?? undefined, hasUI: true, cwd: process.cwd(), ui: { notify: (message: string) => notices.push(message) } };
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  const results: unknown[] = [];
  for (let i = 0; i < session.toolCalls; i++) {
    let result: unknown;
    for (const handler of handlers.get("tool_call") ?? []) result ??= await handler({ type: "tool_call", toolName: "bash", toolCallId: `t${i}`, input: { command: "ls" } }, ctx);
    results.push(result ?? null);
  }
  toolCalls.push(results);
}
const effective = Object.fromEntries(KNOWN.map((id) => [id, id in settings.override ? settings.override[id] : (settings.base[id] ?? [])]));
console.log(JSON.stringify({ overrides, effective, toolCalls, notices }));
