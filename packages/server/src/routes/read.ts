import type { Database } from "bun:sqlite";
import {
  getInbox,
  getIssue,
  getProject,
  issueQueryFromParams,
  listProjects,
  listTriage,
  listWorkspaces,
  queryIssues,
  getDocument,
  listDocuments,
} from "@nod/core";
import type { Hono } from "hono";
import { paramInt, queryFlag } from "../input";

// 読み出しの API。core の戻り値をそのまま JSON で返す
export function registerReadRoutes(app: Hono, db: Database): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces(db)));
  app.get("/api/issues", (c) => c.json(queryIssues(db, issueQueryFromParams(new URL(c.req.url).searchParams))));
  app.get("/api/issues/:id", (c) => c.json(getIssue(db, c.req.param("id"))));
  app.get("/api/inbox", (c) => c.json(getInbox(db, { includeAnswered: queryFlag(c.req.query("includeAnswered"), "includeAnswered") })));
  app.get("/api/triage", (c) => c.json(listTriage(db)));
  app.get("/api/projects", (c) =>
    c.json(listProjects(db, { includeClosed: queryFlag(c.req.query("includeClosed"), "includeClosed") })),
  );
  app.get("/api/projects/:id", (c) => c.json(getProject(db, c.req.param("id"))));
  app.get("/api/documents", (c) => c.json(listDocuments(db)));
  // DocumentContent に作成日とリンク先（issues、projects）を加えた形で返す
  app.get("/api/documents/:id", (c) => c.json(getDocument(db, paramInt(c.req.param("id"), "Document の id "))));
}
