import type { Template } from "../api/types";

// 追加フォームの下書き。名前は前後の空白を除いて送り、本文が空白だけのものは core が拒むので送らない
export function templateAddState(name: string, body: string, existing: readonly Pick<Template, "name">[]) {
  const trimmed = name.trim();
  const duplicated = trimmed !== "" && existing.some((t) => t.name === trimmed);
  return { name: trimmed, duplicated, canSave: trimmed !== "" && body.trim() !== "" };
}

// 本文の下書き。保存済みから変わっていて、空白だけでないときに保存できる
export function templateEditState(draft: string, saved: string) {
  return { canSave: draft.trim() !== "" && draft !== saved };
}

// 一覧の「更新 2026-09-12」。見る人の暦日で出す
export function formatTemplateUpdated(updatedAt: string): string {
  const d = new Date(updatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `更新 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
