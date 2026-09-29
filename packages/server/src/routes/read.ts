import type { Database } from "bun:sqlite";
import {
  getInbox,
  getIssue,
  getProject,
  issueQueryFromParams,
  listProjects,
  listTriage,
  listWorkspaces,
  suggestTriage,
  listTriageProposals,
  HUMAN_ACTOR,
  queryIssues,
  defaultDocsDir,
  getDocument,
  listDocuments,
} from "@nod/core";
import type { Hono } from "hono";
import { paramInt, queryFlag } from "../input";

// 読み出しの API。core の戻り値をそのまま JSON で返す
export function registerReadRoutes(app: Hono, db: Database, docsDir?: string): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces(db)));
  app.get("/api/issues", (c) => c.json(queryIssues(db, issueQueryFromParams(new URL(c.req.url).searchParams))));
  app.get("/api/issues/:id", (c) => c.json(getIssue(db, c.req.param("id"))));
  app.get("/api/inbox", (c) => c.json(getInbox(db, { includeAnswered: queryFlag(c.req.query("includeAnswered"), "includeAnswered") })));
  app.get("/api/triage", (c) => c.json(listTriage(db)));
  // 重複・ラベル・担当の候補（#41）。読み取りだけで、採用は既存の accept / duplicate で人が行う
  app.get("/api/triage/:id/suggestions", (c) => c.json(suggestTriage({ db, actor: HUMAN_ACTOR }, c.req.param("id"))));
  // LLM の提案（#62）。記録は CLI の nod triage propose だけで行い、web は読むだけ。確定は既存の accept / decline / duplicate で人が行う
  app.get("/api/triage/:id/proposals", (c) => c.json(listTriageProposals(db, c.req.param("id"))));
  app.get("/api/projects", (c) =>
    c.json(listProjects(db, { includeClosed: queryFlag(c.req.query("includeClosed"), "includeClosed") })),
  );
  app.get("/api/projects/:id", (c) => c.json(getProject(db, c.req.param("id"))));
  app.get("/api/documents", (c) => c.json(listDocuments(db)));
  // 新規作成フォームで相対パスの前に見せる作成先。/:id より先に登録する
  app.get("/api/documents/root", (c) => c.json({ docsDir: docsDir ?? defaultDocsDir() }));
  // DocumentContent に作成日とリンク先（issues、projects）を加えた形で返す
  app.get("/api/documents/:id", (c) => c.json(getDocument(db, paramInt(c.req.param("id"), "Document の id "))));
}
