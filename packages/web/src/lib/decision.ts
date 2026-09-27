import type { Workspace } from "../api/types";

export function workspaceNameOf(workspaces: readonly Pick<Workspace, "key" | "name">[] | undefined, key: string): string {
  return workspaces?.find((w) => w.key === key)?.name ?? key;
}
