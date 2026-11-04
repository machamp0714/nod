import { spawn } from "node:child_process";

export interface ReviewReferenceDiagnostic {
  reason: "unknown_source" | "invalid_line" | "line_out_of_range";
  field: string;
  requirementUnitIndex: number | null;
  sourceIndex: number | null;
  sourceForm: "catalog_id" | "snapshot_path" | "id_without_type" | "unknown";
  matchedSourceIndex: number | null;
  line: number | null;
  lineCount: number | null;
}

export class ReviewFailure extends Error {
  constructor(readonly code: string, message: string, readonly referenceDiagnostic?: ReviewReferenceDiagnostic) { super(message); }
}

// エラー本文だけを分類する。usageやfallback_creditなどのtelemetryのキーは失敗理由ではない。
export function reviewCliFailure(output: unknown, stderr = "", fallback = "モデルCLIが実行失敗を返しました"): ReviewFailure {
  let parsed = output;
  if (typeof output === "string") {
    try { parsed = JSON.parse(output); } catch { /* JSONでないCLIエラーは本文を判定する。 */ }
  }
  const messages = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(messages);
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    return ["result", "error", "errors", "message", "type", "code"].flatMap(key => messages(row[key]));
  };
  const detail = [...messages(parsed), stderr].join("\n");
  const status = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).api_error_status : undefined;
  if (/prompt is too long|context[_ ](?:length|window)[_ ]exceeded|maximum context length|input.{0,20}too (?:long|large)/i.test(detail)) {
    return new ReviewFailure("INPUT_TOO_LARGE", "モデルの入力上限を超えました。必要な確認範囲を保持して入力の構成を見直してください");
  }
  if (status === 429 || /rate[_ .-]?limit|usage[_ .-]?limit|quota(?:[_ ]exceeded)?|insufficient[_ ]credits?|credit balance.{0,30}(?:low|insufficient|exhausted)|out of credits|利用枠/i.test(detail)) {
    return new ReviewFailure("USAGE_LIMIT", "既存契約の利用枠が不足しています。別課金へ切り替えません");
  }
  if (/not logged in|unauthenticated|authentication|login required|unauthorized/i.test(detail)) {
    return new ReviewFailure("AUTH_REQUIRED", "CLIのサブスクリプション認証を確認できません");
  }
  const subtype = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).subtype : undefined;
  if (subtype === "error_max_structured_output_retries") return new ReviewFailure("OUTPUT_INVALID", "モデルCLIが構造化出力の再試行上限に達しました");
  return new ReviewFailure("CLI_FAILED", fallback);
}

// 認証の解決はCLIへ任せる。APIキー、provider変更、hook、課金関連の環境設定を継承しない。
export function reviewEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NO_COLOR: "1", CLAUDE_CODE_DISABLE_FAST_MODE: "1", CLAUDE_CODE_SAFE_MODE: "1" };
}

/** レビュー専用。既存gh runnerの起動・取消契約は変更しない。 */
export async function reviewProcess(command: string, args: string[], options: {
  cwd: string; input?: string; deadline: number; signal: AbortSignal; maxBytes?: number; temporaryDirectory?: string; isolatedHome?: string; allowNonzero?: boolean; maxStderrBytes?: number;
}): Promise<{ stdout: string; stdoutBytes: Buffer; stderr: string; elapsedMs: number; exitCode: number }> {
  if (options.signal.aborted) throw new ReviewFailure("CANCELLED", "レビューが中断されました");
  if (Date.now() >= options.deadline) throw new ReviewFailure("DEADLINE_EXCEEDED", "レビュー全体の期限に到達しました");
  if (process.platform === "win32") throw new ReviewFailure("CHILD_STOP_UNSUPPORTED", "この環境では子プロセス群の停止を保証できません");
  const started = Date.now();
  const proc = spawn(command, args, { cwd: options.cwd, env: { ...reviewEnvironment(), ...(options.temporaryDirectory ? { TMPDIR: options.temporaryDirectory } : {}), ...(options.isolatedHome ? { HOME: options.isolatedHome, XDG_CONFIG_HOME: options.isolatedHome } : {}) }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let failure: ReviewFailure | undefined;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!proc.pid) return;
    try { process.kill(-proc.pid, signal); } catch (error) {
      // 残るのがゾンビだけのとき、macOSはESRCHでなくEPERMを返す。自分の子のグループで他のEPERMは起きない前提で扱う。
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") failure = new ReviewFailure("CHILD_STOP_FAILED", "子プロセス群を停止できません");
    }
  };
  const stop = (why: ReviewFailure) => {
    if (failure) return;
    failure = why;
    signalGroup("SIGTERM");
    // 直接の子が終了しても孫プロセスへSIGKILLを送る。
    killTimer = setTimeout(() => { signalGroup("SIGKILL"); proc.stdout.destroy(); proc.stderr.destroy(); proc.stdin.destroy(); }, 150);
  };
  const abort = () => stop(new ReviewFailure("CANCELLED", "レビューが中断されました"));
  options.signal.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => stop(new ReviewFailure("DEADLINE_EXCEEDED", "準備から30分以内に設定した全体期限に到達しました")), Math.max(1, options.deadline - Date.now()));
  proc.stdout.on("data", (part: Buffer) => {
    if (stdout.length + part.length > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new ReviewFailure("OUTPUT_TOO_LARGE", "モデルCLIの出力が上限を超えました"));
    else stdout = Buffer.concat([stdout, part]);
  });
  proc.stderr.on("data", (part: Buffer) => { if (options.maxStderrBytes && stderr.length + part.length > options.maxStderrBytes) stop(new ReviewFailure("OUTPUT_TOO_LARGE", "検証の標準エラー出力が上限を超えました")); else stderr = Buffer.concat([stderr, part]).subarray(0, options.maxStderrBytes ?? 64 * 1024); });
  proc.stdin.on("error", () => {});
  proc.stdin.end(options.input ?? "");
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", (error: NodeJS.ErrnoException) => reject(new ReviewFailure(error.code === "ENOENT" ? "CLI_NOT_FOUND" : "CLI_SPAWN_FAILED", "モデルCLIを起動できません")));
      proc.once("close", resolve);
      // 終了した子の子孫が標準出力を保持しても、全体期限まで待たない。
      proc.once("exit", () => {
        exitTimer = setTimeout(() => { signalGroup("SIGKILL"); proc.stdout.destroy(); proc.stderr.destroy(); }, 1000);
      });
    });
    if (killTimer) await new Promise(resolve => setTimeout(resolve, 160));
    // 正常終了後に残された子も次工程へ持ち越さない。
    signalGroup("SIGKILL");
    if (failure) throw failure;
    if (exitCode === null || (exitCode !== 0 && !options.allowNonzero)) {
      throw reviewCliFailure(stdout.toString(), stderr.toString(), `モデルCLIが終了コード ${exitCode} で失敗しました`);
    }
    return { stdout: stdout.toString(), stdoutBytes: stdout, stderr: stderr.toString(), elapsedMs: Date.now() - started, exitCode: exitCode! };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(exitTimer);
    options.signal.removeEventListener("abort", abort);
    signalGroup("SIGKILL");
  }
}
