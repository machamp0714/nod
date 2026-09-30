import { parseSelectedSearch } from "./search";

// Open questions（#173）の URL。selected は選んだ Issue、workspace・project・q は絞り込み、group=none はグループなし（既定は Project ごと）。
// project は Project の数字の ID（Issue 一覧と同じ）
export interface OpenQuestionsSearch {
  selected?: string;
  workspace?: string;
  project?: string;
  q?: string;
  group?: "none";
}

export function parseOpenQuestionsSearch(raw: Record<string, unknown>): OpenQuestionsSearch {
  const out: OpenQuestionsSearch = { ...parseSelectedSearch(raw) };
  if (typeof raw.workspace === "string" && raw.workspace.trim()) out.workspace = raw.workspace.trim().toUpperCase();
  const project = typeof raw.project === "number" ? String(raw.project) : raw.project;
  if (typeof project === "string" && /^\d+$/.test(project)) out.project = project;
  // 数字だけの検索語は、ルーターが数値に直して渡す
  const q = typeof raw.q === "number" ? String(raw.q) : raw.q;
  if (typeof q === "string" && q.trim()) out.q = q;
  if (raw.group === "none") out.group = "none";
  return out;
}
