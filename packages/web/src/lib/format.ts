import type { Question } from "../api/types";

export function formatRelative(iso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

// Issue 一覧の行の右端に出す更新日時（design/nod.pen「11 Issues」O7KCp3）。
// 24時間以内は「12分前」「1時間前」、それより前はローカルの「9月26日」（年が違えば年を付ける）。読めない値は空にする
export function formatUpdated(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (now.getTime() - d.getTime() < 24 * 60 * 60_000) return formatRelative(iso, now);
  const monthDay = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? monthDay : `${d.getFullYear()}年${monthDay}`;
}

export interface QuestionCount {
  decided: number;
  total: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ローカル時刻の「YYYY-MM-DD HH:mm」。読めない値はそのまま返す
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatTime(iso)}`;
}

// ローカル時刻の「HH:mm」。読めない値はそのまま返す
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 経過時間を「時:分:秒」で表す（Toggl の表示と同じ形）。負の値は 0 にする
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 3600)}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
}

export function countQuestions(questions: readonly Pick<Question, "answer">[]): QuestionCount {
  return { decided: questions.filter((q) => q.answer !== null).length, total: questions.length };
}

// spec：未決事項は「決定数 / 総数」（例：2 / 6）で表す。
export function formatQuestionCount(count: QuestionCount): string {
  return count.total === 0 ? "—" : `${count.decided} / ${count.total}`;
}

// 一覧の行の題名の横に出す未決ピルの文言（design/nod.pen「11 Issues｜行：未決ピル」a21Zf）。未回答がなければ出さない
export function formatOpenQuestions(count: QuestionCount): string | null {
  return count.decided < count.total ? `未決 ${count.decided}/${count.total}` : null;
}

export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "PR";
}
