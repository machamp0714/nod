import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import type { Template } from "../types";

interface TemplateRow {
  id: number;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function toTemplate(r: TemplateRow): Template {
  return { id: r.id, name: r.name, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listTemplates(db: Database): Template[] {
  return (db.query("SELECT * FROM templates ORDER BY name").all() as TemplateRow[]).map(toTemplate);
}

export function getTemplate(db: Database, name: string): Template {
  const row = db.query("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | null;
  if (!row) {
    throw new NodError("NOT_FOUND", `テンプレート ${name} はありません。nod template list で登録済みのものを確かめてください`);
  }
  return toTemplate(row);
}

// テンプレートは定期Issueで LLM が実行する手順にもなるため、書き換え・削除は人だけ（#150）。読むのは LLM もできる
function requireHuman(ctx: OpCtx): void {
  if (isLlm(ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM はテンプレートを登録・置き換え・削除できません。変更は me に依頼してください");
  }
}

// 同じ名前があれば本文を置き換える
export function saveTemplate(ctx: OpCtx, input: { name: string; body: string }): { template: Template; created: boolean } {
  requireHuman(ctx);
  const { db } = ctx;
  if (!input.name.trim()) throw new NodError("INVALID_ARGS", "テンプレートの名前を指定してください");
  if (!input.body.trim()) throw new NodError("INVALID_ARGS", "テンプレートの本文が空です");
  return tx(db, () => {
    const ts = now();
    const existing = db.query("SELECT id FROM templates WHERE name = ?").get(input.name) as { id: number } | null;
    if (existing) {
      db.query("UPDATE templates SET body = ?, updated_at = ? WHERE id = ?").run(input.body, ts, existing.id);
    } else {
      db.query("INSERT INTO templates (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        input.name,
        input.body,
        ts,
        ts,
      );
    }
    return { template: getTemplate(db, input.name), created: !existing };
  });
}

export function removeTemplate(ctx: OpCtx, name: string): Template {
  requireHuman(ctx);
  const { db } = ctx;
  return tx(db, () => {
    const template = getTemplate(db, name);
    db.query("DELETE FROM templates WHERE id = ?").run(template.id);
    return template;
  });
}
