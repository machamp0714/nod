import { ApiError } from "../api/client";
import type { GithubLink, GithubPublishPreview, LeakFinding } from "../api/types";

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

// textError は下見の文面そのものの問題（長さの上限など）。編集して再検査が通るまで送れない
export function initialCheck(findings: LeakFinding[], textError: string | null = null): CheckState {
  const status: CheckStatus = textError ? "error" : findings.length ? "found" : "clean";
  return { revision: 0, checkedRevision: 0, status, findings, error: textError };
}

type Blocker = GithubPublishPreview["blockers"][number];

// 文面の長さなどの理由（INVALID_ARGS）は編集で直せるため検査の失敗として扱い、Issue の状態による理由と分ける
export function splitBlockers(blockers: Blocker[]): { text: string | null; others: Blocker[] } {
  const text = blockers.filter((b) => b.code === "INVALID_ARGS").map((b) => b.message);
  return { text: text.length ? text.join("。") : null, others: blockers.filter((b) => b.code !== "INVALID_ARGS") };
}

// GitHub Issue は作成できたが nod に対応を記録できなかった（GITHUB_RECORD_FAILED）ときの、作成済みの URL
export function recordFailedUrl(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== "GITHUB_RECORD_FAILED") return null;
  const url = (e.details as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url.startsWith("https://github.com/") ? url : null;
}

// 作成した試行があれば、紐付けを外しても再公開しない
export function unlinkConfirmText(published: boolean): string {
  return published ? "外しても再公開はできません" : "外したあとは、紐付け直すか GitHub に作成できます";
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
