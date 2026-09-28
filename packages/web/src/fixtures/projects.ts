import type { Project } from "../api/types";
import { ago } from "./time";

export const PROJECT_RECORDS: Project[] = [
  { id: 1, name: "検索 API の高速化", description: "p95 を 200ms 以下にする", status: "started", createdBy: "me", createdAt: ago(60 * 24 * 10), updatedAt: ago(12) },
  { id: 2, name: "決済まわり", description: "Webhook の信頼性を上げる", status: "started", createdBy: "me", createdAt: ago(60 * 24 * 9), updatedAt: ago(41) },
  { id: 3, name: "nod Web UI", description: "判断のための画面", status: "started", createdBy: "me", createdAt: ago(60 * 24 * 2), updatedAt: ago(3) },
  { id: 4, name: "nod CLI", description: "LLM 向けの CLI", status: "completed", createdBy: "me", createdAt: ago(60 * 24 * 5), updatedAt: ago(60) },
  { id: 5, name: "ブログのリニューアル", description: "デザインと OGP", status: "planned", createdBy: "me", createdAt: ago(60 * 24 * 7), updatedAt: ago(60 * 24 * 3) },
];

export function projectRef(id: number): { id: number; name: string } {
  const project = PROJECT_RECORDS.find((p) => p.id === id);
  if (!project) throw new Error(`Project ${id} がダミーデータにありません`);
  return { id: project.id, name: project.name };
}
