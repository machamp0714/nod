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
