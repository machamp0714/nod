import type { GithubLink, LeakFinding } from "../api/types";

// GitHub に Issue を作成する確認ダイアログの判定。編集の版（revision）ごとに検査し、
// 今の版の検査が「検出なし」で終わったときだけ送れる（古い応答で新しい文面を送らないため）
export type CheckStatus = "checking" | "clean" | "found" | "error";

export interface CheckState {
  revision: number; // 編集のたびに増える
  checkedRevision: number; // 結果が届いた版
  status: CheckStatus;
  findings: LeakFinding[];
  error: string | null;
}

export type CheckEvent =
  | { type: "edited" }
  | { type: "result"; revision: number; findings: LeakFinding[] }
  | { type: "failed"; revision: number; error: string };

export function initialCheck(findings: LeakFinding[]): CheckState {
  return { revision: 0, checkedRevision: 0, status: findings.length ? "found" : "clean", findings, error: null };
}

export function checkReducer(state: CheckState, event: CheckEvent): CheckState {
  switch (event.type) {
    case "edited":
      return { ...state, revision: state.revision + 1, status: "checking", error: null };
    case "result":
      if (event.revision !== state.revision) return state;
      return { ...state, checkedRevision: event.revision, status: event.findings.length ? "found" : "clean", findings: event.findings, error: null };
    case "failed":
      if (event.revision !== state.revision) return state;
      return { ...state, checkedRevision: event.revision, status: "error", error: event.error };
  }
}

export function canSend(state: CheckState, opts: { sending: boolean; repo: string | null; ghLogin: string | null; blocked: boolean }): boolean {
  return !opts.sending && !opts.blocked && opts.repo !== null && opts.ghLogin !== null && state.status === "clean" && state.checkedRevision === state.revision;
}

export function findingLocation(f: LeakFinding): string {
  return `${f.field === "title" ? "タイトル" : "本文"} ${f.line} 行 ${f.column} 桁`;
}

export const GITHUB_LINK_ORIGIN_LABEL: Record<GithubLink["origin"], string> = { import: "取り込み", publish: "作成", link: "紐付け" };

export function githubLinkLabel(link: { repo: string; number: number }): string {
  return `${link.repo}#${link.number}`;
}
