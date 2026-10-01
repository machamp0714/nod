import type { OrcaAgent } from "../api/types";

// 「Orca で作業を始める」（#210）の feature 名。使えるのは英小文字・数字・- だけ（API も同じ規則で検証する）

// 初期値：Issue のタイトルに含まれる英数字の語を小文字にして - でつなぐ。英数字が無ければ空
export function defaultFeature(title: string): string {
  return (title.match(/[A-Za-z0-9]+/g) ?? []).join("-").toLowerCase();
}

// 入力欄の値から、使えない文字を落とす。英大文字は小文字にして残す
export function sanitizeFeature(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function worktreeName(issueId: string, feature: string): string {
  return `${issueId}+${feature}`;
}

// 起動できるエージェントと表示名（core の ORCA_AGENT_LABELS と同じ。web は core の値を import しないため、ここに持つ）
const AGENT_LABELS: Record<OrcaAgent, string> = { claude: "Claude Code", codex: "Codex" };
export const ORCA_AGENT_OPTIONS = (Object.keys(AGENT_LABELS) as OrcaAgent[]).map((value) => ({ value, label: AGENT_LABELS[value] }));
export const orcaAgentLabel = (agent: OrcaAgent): string => AGENT_LABELS[agent];
