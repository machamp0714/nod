// ブランチのない実行場所も、記録済みの worktree を失わずに表示する。
export function executionLocation(
  branch: string | null,
  worktree: string | null,
): { branchLabel: string; worktree: string | null } | null {
  if (!branch && !worktree) return null;
  return { branchLabel: branch || "(detached)", worktree };
}
