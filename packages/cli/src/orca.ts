import { orcaCommand, type WorkLocation } from "@nod/core";

export interface OrcaUpdate {
  status?: "in-progress" | "in-review";
  comment: string;
}

const MAX_COMMENT = 80;
const TIMEOUT_MS = 3000;

function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_COMMENT ? text : `${chars.slice(0, MAX_COMMENT - 1).join("")}…`;
}

// Orca のワークツリーのカードを更新する。失敗はすべて false で返し、nod の処理を止めない
export async function notifyOrca(
  update: OrcaUpdate,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (env.NOD_ORCA === "0") return false;
  const command = orcaCommand(env.ORCA_CLI_COMMAND);
  const args = ["worktree", "set", "--worktree", "active"];
  if (update.status) args.push("--workspace-status", update.status);
  args.push("--comment", truncate(update.comment), "--json");
  try {
    const proc = Bun.spawn([...command, ...args], { stdout: "pipe", stderr: "ignore", env });
    // orca が起動した孫プロセスが stdout を握ったままだと、kill しても読み取りが終わらず nod も終われない。
    // そのため時間切れのときは読み取りを取り消して false を返す
    const reader = proc.stdout.getReader();
    const readAll = async (): Promise<string> => {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.all([readAll(), proc.exited]), timeout]);
    clearTimeout(timer);
    if (!result) {
      proc.kill();
      proc.unref();
      await reader.cancel().catch(() => {});
      return false;
    }
    const [out, code] = result;
    if (code !== 0) return false;
    return (JSON.parse(out) as { ok?: boolean }).ok !== false;
  } catch {
    return false;
  }
}

export function currentWorkLocation(cwd: string = process.cwd()): WorkLocation | null {
  try {
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (top.exitCode !== 0) return null;
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const name = branch.exitCode === 0 ? branch.stdout.toString().trim() : "";
    return { worktree: top.stdout.toString().trim(), branch: name && name !== "HEAD" ? name : null };
  } catch {
    return null;
  }
}
