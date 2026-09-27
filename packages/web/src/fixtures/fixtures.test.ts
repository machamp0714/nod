import { describe, expect, test } from "bun:test";
import { DOCUMENTS, ISSUE_DOCUMENTS, PROJECT_DOCUMENTS } from "./documents";
import { INBOX, TRIAGE_ISSUES } from "./inbox";
import { ISSUES, QUESTIONS } from "./issues";
import { PROJECTS } from "./project-summaries";
import { PROJECT_RECORDS } from "./projects";
import { VIEWS } from "./views";
import { WORKSPACES } from "./workspaces";

const issueIds = new Set(ISSUES.map((i) => i.id));
const documentIds = new Set(DOCUMENTS.map((d) => d.id));

describe("ダミーデータの整合", () => {
  test("Issue の ID は一意で、Workspace のキーと番号から成る", () => {
    expect(issueIds.size).toBe(ISSUES.length);
    const keys = new Set(WORKSPACES.map((w) => w.key));
    for (const issue of ISSUES) {
      expect(keys.has(issue.workspace)).toBe(true);
      expect(issue.id).toBe(`${issue.workspace}-${issue.number}`);
    }
  });

  test("質問、親、Project の参照先が存在する", () => {
    for (const q of QUESTIONS) expect(issueIds.has(q.issueId)).toBe(true);
    for (const issue of ISSUES) {
      if (issue.parentId) expect(issueIds.has(issue.parentId)).toBe(true);
      if (issue.project) {
        expect(PROJECT_RECORDS.find((p) => p.id === issue.project?.id)?.name).toBe(issue.project.name);
      }
    }
  });

  test("すべてのステータスの Issue がある", () => {
    const statuses = new Set(ISSUES.map((i) => i.status));
    for (const s of ["triage", "backlog", "needs_clarification", "todo", "in_progress", "in_review", "done", "canceled"]) {
      expect(statuses.has(s as never)).toBe(true);
    }
  });

  test("Document の添付先が存在する", () => {
    for (const ids of [...Object.values(PROJECT_DOCUMENTS), ...Object.values(ISSUE_DOCUMENTS)]) {
      for (const id of ids) expect(documentIds.has(id)).toBe(true);
    }
    for (const issueId of Object.keys(ISSUE_DOCUMENTS)) expect(issueIds.has(issueId)).toBe(true);
  });

  test("Inbox は LLM の未回答の質問を新しい順に並べ、Triage は triage の Issue だけを持つ", () => {
    expect(INBOX.questions.map((q) => q.issueId)).toEqual(["API-12", "API-8", "BLOG-2"]);
    expect(INBOX.questions.every((q) => q.askedBy !== "me" && q.answer === null)).toBe(true);
    expect(INBOX.reviews.map((i) => i.id)).toEqual(["API-7"]);
    expect(TRIAGE_ISSUES.map((i) => i.id)).toEqual(["API-15", "API-16"]);
  });

  test("Project の集計は Issue から数える", () => {
    const search = PROJECTS.find((p) => p.id === 1);
    expect(search).toMatchObject({ total: 3, done: 0, workspaces: ["API"] });
    expect(search?.agents).toEqual({ working: 0, awaitingInput: 1, error: 0 });
    expect(VIEWS.map((v) => v.name)).toEqual(["仕事", "プライベート"]);
  });
});
