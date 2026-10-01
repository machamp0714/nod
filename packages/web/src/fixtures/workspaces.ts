import type { Workspace } from "../api/types";
import { ago } from "./time";

export const WORKSPACES: Workspace[] = [
  { id: 1, color: "#7C5CFF", key: "API", name: "api-server", path: "/Users/me/repo/api-server", defaultAgent: "claude", createdAt: ago(60 * 24 * 40) },
  { id: 2, color: "#0D9768", key: "NOD", name: "nod", path: "/Users/me/repo/nod", defaultAgent: "claude", createdAt: ago(60 * 24 * 30) },
  { id: 3, color: "#C36B04", key: "BLOG", name: "blog", path: "/Users/me/repo/blog", defaultAgent: "claude", createdAt: ago(60 * 24 * 20) },
];

export function workspaceName(key: string): string {
  return WORKSPACES.find((w) => w.key === key)?.name ?? key;
}
