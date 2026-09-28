import type { Question } from "../api/types";

export function formatRelative(iso: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export interface QuestionCount {
  decided: number;
  total: number;
}

export function countQuestions(questions: readonly Pick<Question, "answer">[]): QuestionCount {
  return { decided: questions.filter((q) => q.answer !== null).length, total: questions.length };
}

// spec：未決事項は「決定数 / 総数」（例：2 / 6）で表す。
export function formatQuestionCount(count: QuestionCount): string {
  return count.total === 0 ? "—" : `${count.decided} / ${count.total}`;
}

export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : "PR";
}
