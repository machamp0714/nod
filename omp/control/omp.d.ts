// 制御の拡張（index.ts）が使う OMP のモジュールの、使う部分だけの型宣言（型検査のため）。
// @oh-my-pi/pi-coding-agent は nod のリポジトリの依存に無い。実行時は OMP（固定の記録の版）が自分のモジュールを渡す。
declare module "@oh-my-pi/pi-coding-agent" {
  // OMP の設定のインスタンス（中身は registry の handle に渡すだけ。worker thread の写しかどうかだけを見る）
  export interface Settings {
    readonly __ompSettings: unique symbol;
    // worker thread で、メインのスレッドの設定を写したもの
    readonly isMirror?: boolean;
    // この設定が重なっている下の設定（無ければ undefined）
    overlayParent?(): Settings | undefined;
  }

  export interface ExtensionAgentIdentity {
    // トップレベルのセッションは main、起動された子と孫は sub
    kind: "main" | "sub";
    id: string;
    name: string;
    depth: number;
    parentId?: string;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    cwd: string;
    agent?: ExtensionAgentIdentity;
    ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  }

  export interface ToolCallEvent {
    toolName: string;
    input: unknown;
  }

  export interface ToolCallEventResult {
    block?: boolean;
    reason?: string;
  }

  // 子を起動する直前（task・eval の agent()・workpool）。親のセッションに1子ごとに1度届く。agent は起動する子のエージェントの名前
  export interface BeforeSubagentSpawnEvent {
    agent?: string;
    invocationKind?: string;
  }

  // custom message（customType が同じもの）の TUI での描き方。render は幅を受けて行の配列を返す
  export interface MessageComponent {
    render(width: number): string[];
    invalidate(): void;
  }

  export interface ExtensionAPI {
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
    on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>): void;
    on(
      event: "before_subagent_spawn",
      handler: (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>,
    ): void;
    registerMessageRenderer(customType: string, renderer: (message: { content: unknown }) => MessageComponent): void;
    readonly pi: { readonly settings: Settings };
  }
}

declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  import type { Settings } from "@oh-my-pi/pi-coding-agent";

  export interface Setting {
    // 全部の層（実行時の上書き・--config・project・global・既定）を合わせた実効値
    get(scope: Settings): unknown;
    // 実行時の層に書く（永続しない。配列と record の値は置き換え）
    override(scope: Settings, value: unknown): void;
    // 実効値がどの層から来たか（実行時の上書きなら "runtime"。ほかに "overlay"（--config）・"project"・"global"・"default" など）
    provenance(scope: Settings): string;
  }

  export function lookup(id: string): Setting | undefined;
}
