const TIMEOUT_MS = 3000;

// BROWSER があればそれを、なければ OS ごとに既定のブラウザで URL を開くコマンドを返す
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.BROWSER) return [env.BROWSER, url];
  if (platform === "darwin") return ["open", url];
  // start は最初の引数を窓のタイトルとして読むため、空のタイトルを渡す
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

// 開けたら true。コマンドがない、失敗した、のどちらでも例外を投げずに false を返す。
// xdg-open はブラウザを閉じるまで終わらないことがあるため、TIMEOUT_MS で終わらなければ開けたものとして待つのをやめる
export async function openBrowser(url: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const proc = Bun.spawn(openCommand(url), { stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    let abort!: () => void;
    const aborted = new Promise<null>((resolve) => {
      abort = () => resolve(null);
      signal?.addEventListener("abort", abort, { once: true });
    });
    let code: number | null;
    try {
      code = await Promise.race([proc.exited, timeout, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    if (code === null) {
      proc.unref();
      return !signal?.aborted;
    }
    return code === 0;
  } catch {
    return false;
  }
}
