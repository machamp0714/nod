import { createCommandRunner, type GhRunner } from "./pr-status";

export type GitRunner = GhRunner;
// 呼び出し元の GIT_ 環境変数から独立して、明示したリポジトリを読む。
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("GIT_")));
}
export const gitRunner: GitRunner = createCommandRunner("git", [], { env: gitEnv });
