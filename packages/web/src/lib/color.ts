const WORKSPACE_COLORS = ["var(--ws-a)", "var(--ws-b)", "var(--ws-c)", "var(--ws-d)"] as const;

// workspaces に色の列はないため、キーから決める。同じキーは常に同じ色になる。
export function workspaceColor(key: string): string {
  let sum = 0;
  for (const ch of key) sum += ch.charCodeAt(0);
  return WORKSPACE_COLORS[sum % WORKSPACE_COLORS.length] ?? WORKSPACE_COLORS[0];
}

export function agentColor(actor: string): string {
  if (actor === "claude-code") return "var(--claude)";
  if (actor === "codex") return "var(--codex)";
  if (actor === "me") return "var(--accent)";
  return "var(--gate)";
}

export function agentInitial(actor: string): string {
  if (actor === "codex") return "X";
  return (actor[0] ?? "?").toUpperCase();
}
