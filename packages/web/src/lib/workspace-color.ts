import type { Workspace } from "../api/types";

export function workspaceColorOf(
  workspaces: readonly Pick<Workspace, "key" | "color">[] | undefined,
  key: string,
): string | undefined {
  const color = workspaces?.find((workspace) => workspace.key === key)?.color;
  return color?.length === 7 && /^#[0-9A-F]{6}$/.test(color) ? color : undefined;
}
