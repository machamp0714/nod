import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findIssueRow, type IssueRow } from "../issue-query";
import type { DocKind, DocumentRef } from "../types";
import { resolveProject } from "./projects";

export function documentTitle(path: string, content: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  return m?.[1] ?? basename(path);
}

export function readDocumentFile(path: string, cwd: string = process.cwd()): { abs: string; content: string } {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new NodError("FILE_NOT_FOUND", `${abs} が見つかりません`);
  return { abs, content: readFileSync(abs, "utf8") };
}

export interface DocTarget {
  issueRef?: string;
  projectRef?: string;
}

export interface ResolvedTarget {
  issue?: IssueRow;
  projectId?: number;
}

export function resolveDocTarget(db: Database, target: DocTarget): ResolvedTarget {
  if (Boolean(target.issueRef) === Boolean(target.projectRef)) {
    throw new NodError("INVALID_ARGS", "添付先には Issue か Project のどちらか一方を指定してください");
  }
  return target.issueRef
    ? { issue: findIssueRow(db, target.issueRef) }
    : { projectId: resolveProject(db, target.projectRef as string).id };
}

export function linkDocument(
  ctx: OpCtx,
  target: ResolvedTarget,
  input: { path: string; content: string; title?: string; kind?: DocKind },
): DocumentRef {
  const existing = ctx.db.query("SELECT id, path, title, kind FROM documents WHERE path = ?").get(input.path) as
    | DocumentRef
    | null;
  let doc: DocumentRef;
  if (existing) {
    doc = { ...existing, title: input.title ?? existing.title, kind: input.kind ?? existing.kind };
    ctx.db.query("UPDATE documents SET title = ?, kind = ? WHERE id = ?").run(doc.title, doc.kind, doc.id);
  } else {
    const title = input.title ?? documentTitle(input.path, input.content);
    const kind = input.kind ?? "doc";
    const { lastInsertRowid } = ctx.db
      .query("INSERT INTO documents (path, title, kind, created_at) VALUES (?, ?, ?, ?)")
      .run(input.path, title, kind, now());
    doc = { id: Number(lastInsertRowid), path: input.path, title, kind };
  }
  if (target.issue) {
    const { changes } = ctx.db
      .query("INSERT OR IGNORE INTO document_links (document_id, issue_id) VALUES (?, ?)")
      .run(doc.id, target.issue.id);
    if (changes > 0) recordEvent(ctx.db, target.issue.id, ctx.actor, "document_attached", { document_id: doc.id });
  } else {
    ctx.db.query("INSERT OR IGNORE INTO document_links (document_id, project_id) VALUES (?, ?)").run(doc.id, target.projectId ?? null);
  }
  return doc;
}

export function attachDocument(
  ctx: OpCtx,
  target: DocTarget,
  input: { path: string; title?: string; kind?: DocKind; cwd?: string },
): DocumentRef {
  const { abs, content } = readDocumentFile(input.path, input.cwd);
  return tx(ctx.db, () =>
    linkDocument(ctx, resolveDocTarget(ctx.db, target), { path: abs, content, title: input.title, kind: input.kind }),
  );
}

export function detachDocument(ctx: OpCtx, target: DocTarget, path: string, cwd: string = process.cwd()): void {
  const abs = resolve(cwd, path);
  tx(ctx.db, () => {
    const resolved = resolveDocTarget(ctx.db, target);
    const doc = ctx.db.query("SELECT id FROM documents WHERE path = ?").get(abs) as { id: number } | null;
    const { changes } = doc
      ? resolved.issue
        ? ctx.db.query("DELETE FROM document_links WHERE document_id = ? AND issue_id = ?").run(doc.id, resolved.issue.id)
        : ctx.db.query("DELETE FROM document_links WHERE document_id = ? AND project_id = ?").run(doc.id, resolved.projectId ?? null)
      : { changes: 0 };
    if (!doc || changes === 0) throw new NodError("NOT_FOUND", `${abs} は添付されていません`);
    if (resolved.issue) recordEvent(ctx.db, resolved.issue.id, ctx.actor, "document_detached", { document_id: doc.id });
  });
}
