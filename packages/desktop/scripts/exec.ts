// 外部コマンドの実行（Bun.spawnSync の薄い包み）。build.ts・deploy.ts・verify-app.ts が共有する。
export interface ExecResult {
  /** 終了コード。起動できなかった・シグナルで終了した場合は -1 */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** 出力を取り込んで実行する。起動に失敗しても例外は投げず、code -1 と stderr に原因を入れて返す。 */
export function capture(cmd: string[], opts: ExecOptions = {}): ExecResult {
  try {
    const r = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e) };
  }
}

/** 出力をそのまま端末へ流して実行し、終了コードを返す。 */
export function runInherit(cmd: string[], opts: { cwd?: string } = {}): number {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, stdout: "inherit", stderr: "inherit" });
  return r.exitCode ?? -1;
}
