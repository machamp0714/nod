import type { OpenQuestion } from "../api/types";

// Open questions（#173）の一覧の1項目。1 Issue = 1項目で、その Issue の未回答の未決事項をまとめる
export interface OpenQuestionEntry {
  issueId: string;
  issueTitle: string;
  workspace: string;
  status: OpenQuestion["status"];
  priority: number;
  project: OpenQuestion["project"];
  questionCount: OpenQuestion["questionCount"];
  questions: OpenQuestion[]; // server の順（質問の id 順）
  oldestAt: string; // 最古の未回答の質問時刻
}

// GET /api/open-questions は質問ごとに、Issue がまとまった順（優先度、最古の質問の古い順）で返す。その順のまま Issue ごとにまとめる
export function groupOpenQuestions(questions: readonly OpenQuestion[]): OpenQuestionEntry[] {
  const entries = new Map<string, OpenQuestionEntry>();
  for (const question of questions) {
    const entry = entries.get(question.issueId);
    if (entry) {
      entry.questions.push(question);
      if (question.askedAt < entry.oldestAt) entry.oldestAt = question.askedAt;
      continue;
    }
    entries.set(question.issueId, {
      issueId: question.issueId,
      issueTitle: question.issueTitle,
      workspace: question.workspace,
      status: question.status,
      priority: question.priority,
      project: question.project,
      questionCount: question.questionCount,
      questions: [question],
      oldestAt: question.askedAt,
    });
  }
  return [...entries.values()];
}

export interface OpenQuestionFilter {
  workspace?: string; // Workspace のキー
  project?: number; // Project の ID
  q?: string; // 質問文・Issue のタイトル・ID の文字列検索
}

// 絞り込みは Issue 単位。検索が質問文に合ったときも、その Issue の未決事項はすべて残す（まとめて決めるため）
export function filterOpenQuestionEntries(entries: readonly OpenQuestionEntry[], filter: OpenQuestionFilter): OpenQuestionEntry[] {
  const needle = filter.q?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (filter.workspace !== undefined && entry.workspace !== filter.workspace) return false;
    if (filter.project !== undefined && entry.project?.id !== filter.project) return false;
    if (!needle) return true;
    return [entry.issueId, entry.issueTitle, ...entry.questions.map((q) => q.question)].some((text) => text.toLowerCase().includes(needle));
  });
}

export type OpenQuestionGroup = "project" | "none";

export interface OpenQuestionSection {
  key: string;
  label: string | null; // 見出し。グループなしは null
  count: number; // 未回答の質問の数
  entries: OpenQuestionEntry[];
}

const countOf = (entries: readonly OpenQuestionEntry[]) => entries.reduce((sum, e) => sum + e.questions.length, 0);

// Project ごとの区切り。Project は名前順、Project のない Issue は最後にまとめる
export function openQuestionSections(entries: readonly OpenQuestionEntry[], group: OpenQuestionGroup): OpenQuestionSection[] {
  if (entries.length === 0) return [];
  if (group === "none") return [{ key: "all", label: null, count: countOf(entries), entries: [...entries] }];
  const byProject = new Map<number | null, OpenQuestionEntry[]>();
  for (const entry of entries) {
    const id = entry.project?.id ?? null;
    byProject.set(id, [...(byProject.get(id) ?? []), entry]);
  }
  return [...byProject.entries()]
    .map(([id, list]) => ({ key: id === null ? "none" : String(id), label: list[0]!.project?.name ?? "Project なし", count: countOf(list), entries: list, none: id === null }))
    .sort((a, b) => Number(a.none) - Number(b.none) || a.label.localeCompare(b.label, "ja"))
    .map(({ none: _none, ...section }) => section);
}

// 絞り込みの選択肢。未決事項のある Workspace と Project だけを出す
export function openQuestionFilterOptions(entries: readonly OpenQuestionEntry[]): { workspaces: string[]; projects: { id: number; name: string }[] } {
  const projects = new Map<number, { id: number; name: string }>();
  for (const entry of entries) if (entry.project) projects.set(entry.project.id, entry.project);
  return {
    workspaces: [...new Set(entries.map((e) => e.workspace))].sort(),
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, "ja")),
  };
}

// 回答で Issue が一覧から消えたあとに選ぶ Issue。消える前の並び（before）で次にあったもの、なければ手前のものにする
export function nextOpenQuestionEntry(before: readonly string[], after: readonly string[], selected: string | undefined): string | undefined {
  if (selected !== undefined && after.includes(selected)) return selected;
  const at = selected === undefined ? -1 : before.indexOf(selected);
  if (at === -1) return after[0];
  const remaining = new Set(after);
  return before.slice(at + 1).find((id) => remaining.has(id)) ?? before.slice(0, at).reverse().find((id) => remaining.has(id));
}
