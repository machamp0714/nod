import type { Database } from "bun:sqlite";
import { isLlm, type OpCtx } from "./ctx";
import { tx } from "./db";
import { NodError } from "./errors";
import { findWorkspace } from "./ops/workspaces";
import { getStatusNames, statusDisplayName } from "./status-names";
import { STATUSES, type Status, type Workspace } from "./types";

// ステータスの遷移ルール（#73）。8状態は固定のまま、Workspace ごとに許可しない遷移を人が設定する。未設定なら制限なし。
// ルールは制限を足すだけで、既存の保護（Triage の判断は人のみ、LLM は done にしない、レビュー承認）を緩めない

// needs_clarification は確認依頼に応じて core が切り替えるため、ルールの from・to に指定できない
export const RULE_STATUSES: Status[] = STATUSES.filter((s) => s !== "needs_clarification");

export const TRANSITION_PRESETS = ["review_before_done"] as const;
export type TransitionPreset = (typeof TRANSITION_PRESETS)[number];

export const TRANSITION_PRESET_LABELS: Record<TransitionPreset, string> = {
  review_before_done: "done の前に in_review 必須",
};

// 塞ぐとレビュー依頼・承認・差し戻し・Triage の判断ができなくなる遷移。ルールで禁止できない
const PROTECTED_PAIRS: { from: Status; to: Status; why: string }[] = [
  { from: "in_review", to: "done", why: "レビュー承認に必要" },
  { from: "in_progress", to: "in_review", why: "レビュー依頼（nod issue done）に必要" },
  { from: "in_review", to: "in_progress", why: "レビューの差し戻しに必要" },
  { from: "triage", to: "todo", why: "Triage の受け入れに必要" },
  { from: "triage", to: "canceled", why: "Triage の却下・重複に必要" },
];

export interface TransitionPair {
  from: Status;
  to: Status;
}

export interface WorkspaceTransitionRules {
  workspaceKey: string;
  forbidden: TransitionPair[]; // 状態の表示順（from、to の順）
  presets: TransitionPreset[];
}

export type TransitionRuleRef = { kind: "forbidden" } | { kind: "preset"; preset: TransitionPreset };

export interface TransitionRulesInput {
  forbidden?: { from: string; to: string }[];
  presets?: string[];
}

function requireWorkspace(db: Database, keyOrPath: string): Workspace {
  const workspace = findWorkspace(db, keyOrPath);
  if (!workspace) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
  return workspace;
}

const order = (s: Status) => STATUSES.indexOf(s);

function readRules(db: Database, workspace: Workspace): WorkspaceTransitionRules {
  const pairs = db
    .query("SELECT from_status AS \"from\", to_status AS \"to\" FROM workspace_transition_rules WHERE workspace_id = ?")
    .all(workspace.id) as TransitionPair[];
  const presets = (
    db.query("SELECT preset FROM workspace_transition_presets WHERE workspace_id = ?").all(workspace.id) as { preset: string }[]
  ).map((r) => r.preset);
  return {
    workspaceKey: workspace.key,
    forbidden: pairs.sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to)),
    presets: TRANSITION_PRESETS.filter((p) => presets.includes(p)),
  };
}

export function getTransitionRules(db: Database, keyOrPath: string): WorkspaceTransitionRules {
  return readRules(db, requireWorkspace(db, keyOrPath));
}

function ruleStatus(value: unknown, what: string): Status {
  if (typeof value !== "string" || !(STATUSES as readonly string[]).includes(value)) {
    throw new NodError("INVALID_ARGS", `${what}のステータスが不明です: ${String(value)}（${RULE_STATUSES.join(", ")} のいずれか）`);
  }
  if (value === "needs_clarification") {
    throw new NodError("INVALID_ARGS", "needs_clarification は確認依頼に応じて自動で切り替わるため、遷移ルールに指定できません");
  }
  return value as Status;
}

// 禁止する遷移の組とプリセットを全体で置き換える（人だけ）。重複は1件にまとめる
export function setTransitionRules(ctx: OpCtx, keyOrPath: string, input: TransitionRulesInput): WorkspaceTransitionRules {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はステータスの遷移ルールを変更できません。変更は me に依頼してください");
  }
  const forbidden = new Map<string, TransitionPair>();
  for (const raw of input.forbidden ?? []) {
    if (raw === null || typeof raw !== "object") {
      throw new NodError("INVALID_ARGS", "許可しない遷移は { from, to } で指定してください");
    }
    const from = ruleStatus(raw.from, "遷移元");
    const to = ruleStatus(raw.to, "遷移先");
    if (from === to) throw new NodError("INVALID_ARGS", `同じステータスへの遷移は指定できません（${from}）`);
    const guarded = PROTECTED_PAIRS.find((p) => p.from === from && p.to === to);
    if (guarded) throw new NodError("INVALID_ARGS", `${from} → ${to} は禁止できません（${guarded.why}）`);
    forbidden.set(`${from}:${to}`, { from, to });
  }
  const presets = new Set<TransitionPreset>();
  for (const raw of input.presets ?? []) {
    if (!(TRANSITION_PRESETS as readonly string[]).includes(raw)) {
      throw new NodError("INVALID_ARGS", `不明なプリセットです: ${raw}（${TRANSITION_PRESETS.join(", ")} のいずれか）`);
    }
    presets.add(raw as TransitionPreset);
  }
  return tx(ctx.db, () => {
    const workspace = requireWorkspace(ctx.db, keyOrPath);
    ctx.db.query("DELETE FROM workspace_transition_rules WHERE workspace_id = ?").run(workspace.id);
    ctx.db.query("DELETE FROM workspace_transition_presets WHERE workspace_id = ?").run(workspace.id);
    const insertPair = ctx.db.query("INSERT INTO workspace_transition_rules (workspace_id, from_status, to_status) VALUES (?, ?, ?)");
    for (const p of forbidden.values()) insertPair.run(workspace.id, p.from, p.to);
    const insertPreset = ctx.db.query("INSERT INTO workspace_transition_presets (workspace_id, preset) VALUES (?, ?)");
    for (const p of presets) insertPreset.run(workspace.id, p);
    return readRules(ctx.db, workspace);
  });
}

export function resetTransitionRules(ctx: OpCtx, keyOrPath: string): WorkspaceTransitionRules {
  return setTransitionRules(ctx, keyOrPath, {});
}

// from → to を止めるルール。制限がなければ null
export function transitionViolation(db: Database, workspaceId: number, from: Status, to: Status): TransitionRuleRef | null {
  if (from === to) return null;
  const pair = db
    .query("SELECT 1 FROM workspace_transition_rules WHERE workspace_id = ? AND from_status = ? AND to_status = ?")
    .get(workspaceId, from, to);
  if (pair) return { kind: "forbidden" };
  if (to === "done" && from !== "in_review") {
    const preset = db
      .query("SELECT 1 FROM workspace_transition_presets WHERE workspace_id = ? AND preset = 'review_before_done'")
      .get(workspaceId);
    if (preset) return { kind: "preset", preset: "review_before_done" };
  }
  return null;
}

// 違反の説明。表示名は Workspace の設定（#26）を使う
export function transitionViolationMessage(db: Database, workspaceKey: string, from: Status, to: Status, rule: TransitionRuleRef): string {
  const names = getStatusNames(db, workspaceKey).names;
  const label = rule.kind === "preset" ? TRANSITION_PRESET_LABELS[rule.preset] : "許可しない遷移";
  return `${statusDisplayName(from, names)} → ${statusDisplayName(to, names)} は許可されていません（ルール: ${label}）`;
}

// 自動化（#66/#68/#71）が遷移をスキップするときの理由。止めるルールがなければ null
export function transitionBlockReason(db: Database, workspace: { id: number; key: string }, from: Status, to: Status): string | null {
  const rule = transitionViolation(db, workspace.id, from, to);
  return rule ? `遷移ルールでスキップ: ${transitionViolationMessage(db, workspace.key, from, to, rule)}` : null;
}

// 状態変更の共通経路（setColumn）から呼ぶ。違反なら TRANSITION_NOT_ALLOWED
export function assertTransitionAllowed(
  db: Database,
  issue: { workspace_id: number; ws_key: string },
  from: Status,
  to: Status,
): void {
  const rule = transitionViolation(db, issue.workspace_id, from, to);
  if (!rule) return;
  throw new NodError("TRANSITION_NOT_ALLOWED", transitionViolationMessage(db, issue.ws_key, from, to, rule), { from, to, rule });
}

// LLM 向けの出力に添える節。制限がなければ空文字
export function formatTransitionRulesSection(rules: WorkspaceTransitionRules): string {
  if (rules.forbidden.length === 0 && rules.presets.length === 0) return "";
  const lines = [
    ...rules.presets.map((p) => `- ${TRANSITION_PRESET_LABELS[p]}`),
    ...rules.forbidden.map((p) => `- ${p.from} → ${p.to} は禁止`),
  ];
  return `## この Workspace のステータス遷移ルール（${rules.workspaceKey}）\n\n人が設定したルールである。違反する遷移は TRANSITION_NOT_ALLOWED で拒否される。LLM はルールを変更できない。\n\n${lines.join("\n")}\n`;
}
