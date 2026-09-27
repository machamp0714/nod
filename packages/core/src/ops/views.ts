import type { Database } from "bun:sqlite";
import { tx } from "../db";
import { NodError } from "../errors";
import { type IssueQuery, validateIssueQuery } from "../issue-filter";

export interface View {
  id: number;
  name: string;
  color: string | null;
  filter: IssueQuery;
  position: number;
}

export interface ViewInput {
  name?: string;
  color?: string | null;
  filter?: unknown; // IssueQuery の形。書き込む前に validateIssueQuery で確かめる
  position?: number;
}

interface ViewRow {
  id: number;
  name: string;
  color: string | null;
  filter: string;
  position: number;
}

function toView(r: ViewRow): View {
  return { id: r.id, name: r.name, color: r.color, filter: JSON.parse(r.filter) as IssueQuery, position: r.position };
}

function checkName(db: Database, name: string, selfId: number | null): void {
  if (!name.trim()) throw new NodError("INVALID_ARGS", "View の名前を指定してください");
  const other = db.query("SELECT id FROM views WHERE name = ?").get(name) as { id: number } | null;
  if (other && other.id !== selfId) throw new NodError("VIEW_EXISTS", `View ${name} はすでにあります`);
}

function checkPosition(position: number | undefined): void {
  if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
    throw new NodError("INVALID_ARGS", "position は0以上の整数で指定してください");
  }
}

export function listViews(db: Database): View[] {
  return (db.query("SELECT * FROM views ORDER BY position, id").all() as ViewRow[]).map(toView);
}

export function getView(db: Database, id: number): View {
  const row = db.query("SELECT * FROM views WHERE id = ?").get(id) as ViewRow | null;
  if (!row) throw new NodError("NOT_FOUND", `View ${id} はありません`);
  return toView(row);
}

export function createView(db: Database, input: ViewInput & { name: string }): View {
  const filter = validateIssueQuery(input.filter ?? {});
  checkPosition(input.position);
  return tx(db, () => {
    checkName(db, input.name, null);
    const position =
      input.position ?? (db.query("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM views").get() as { p: number }).p;
    const { lastInsertRowid } = db
      .query("INSERT INTO views (name, color, filter, position) VALUES (?, ?, ?, ?)")
      .run(input.name, input.color ?? null, JSON.stringify(filter), position);
    return getView(db, Number(lastInsertRowid));
  });
}

// 渡した項目だけを変える
export function updateView(db: Database, id: number, input: ViewInput): View {
  const filter = input.filter === undefined ? undefined : validateIssueQuery(input.filter);
  checkPosition(input.position);
  return tx(db, () => {
    const view = getView(db, id);
    if (input.name !== undefined) checkName(db, input.name, id);
    db.query("UPDATE views SET name = ?, color = ?, filter = ?, position = ? WHERE id = ?").run(
      input.name ?? view.name,
      input.color === undefined ? view.color : input.color,
      JSON.stringify(filter ?? view.filter),
      input.position ?? view.position,
      id,
    );
    return getView(db, id);
  });
}

export function deleteView(db: Database, id: number): View {
  return tx(db, () => {
    const view = getView(db, id);
    db.query("DELETE FROM views WHERE id = ?").run(id);
    return view;
  });
}
