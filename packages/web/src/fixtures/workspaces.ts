import type { Workspace } from "../api/types";
import { ago } from "./time";

export const WORKSPACES: Workspace[] = [
  { id: 1, key: "API", name: "api-server", path: "/Users/me/repo/api-server", createdAt: ago(60 * 24 * 40) },
  { id: 2, key: "NOD", name: "nod", path: "/Users/me/repo/nod", createdAt: ago(60 * 24 * 30) },
  { id: 3, key: "BLOG", name: "blog", path: "/Users/me/repo/blog", createdAt: ago(60 * 24 * 20) },
];

export function workspaceName(key: string): string {
  return WORKSPACES.find((w) => w.key === key)?.name ?? key;
}
