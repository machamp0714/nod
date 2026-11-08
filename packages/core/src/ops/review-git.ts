import { spawn } from "node:child_process";
import { gitEnv } from "./git-runner";
import { ReviewFailure } from "./review-failure";

/** Git一呼出しの保護。担当実行・レビュー全体の期限や子プロセス管理を持たない。 */
export async function reviewGit(args: string[], options: { cwd: string; input?: string; maxBytes?: number }) {
  const proc = spawn("git", args, { cwd: options.cwd, env: gitEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let bytes = 0, failure: ReviewFailure | undefined;
  const timer = setTimeout(() => { failure = new ReviewFailure("GIT_FAILED", "Gitの一回の呼出しが時間切れになりました"); proc.kill("SIGKILL"); }, 60_000);
  proc.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) { failure = new ReviewFailure("OUTPUT_TOO_LARGE", "Gitの出力が上限を超えました"); proc.kill("SIGKILL"); }
    else chunks.push(chunk);
  });
  proc.stderr.resume();
  proc.stdin.on("error", () => {});
  proc.stdin.end(options.input ?? "");
  try {
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    proc.once("error", () => reject(new ReviewFailure("GIT_FAILED", "固定対象を読むGitを起動できません")));
    proc.once("close", resolve);
    const exitCode = await promise;
    if (failure) throw failure;
    if (exitCode !== 0) throw new ReviewFailure("GIT_FAILED", "Gitで固定対象を取得できません");
    const stdoutBytes = Buffer.concat(chunks, bytes);
    return { stdout: stdoutBytes.toString("utf8"), stdoutBytes };
  } finally { clearTimeout(timer); }
}
