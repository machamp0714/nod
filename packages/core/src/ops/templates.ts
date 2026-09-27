import type { Database } from "bun:sqlite";
import { now } from "../ctx";
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

// 同じ名前があれば本文を置き換える
export function saveTemplate(db: Database, input: { name: string; body: string }): { template: Template; created: boolean } {
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

export function removeTemplate(db: Database, name: string): Template {
  return tx(db, () => {
    const template = getTemplate(db, name);
    db.query("DELETE FROM templates WHERE id = ?").run(template.id);
    return template;
  });
}
