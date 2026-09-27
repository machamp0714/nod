import { describe, expect, test } from "bun:test";
import { issueQueryFromParams, validateIssueQuery } from "../src/issue-filter";
import { codeOf } from "./helpers";

describe("validateIssueQuery", () => {
  test("Workspace のキーを大文字にし、重複と空を除き、ready: false は省く", () => {
    expect(
      validateIssueQuery({
        workspace: ["api", "API", "web"],
        status: "todo, in_progress",
        project: "検索",
        label: ["bug", "bug", ""],
        ready: false,
      }),
    ).toEqual({ workspace: ["API", "WEB"], status: ["todo", "in_progress"], project: "検索", label: ["bug"] });
    expect(validateIssueQuery({})).toEqual({});
  });

  test("知らないキー、知らないステータス、型の誤りは INVALID_ARGS", () => {
    expect(codeOf(() => validateIssueQuery({ assignee: "me" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery({ status: ["wip"] }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery({ ready: "yes" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery({ label: [1] }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery({ project: "" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery([]))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery(null))).toBe("INVALID_ARGS");
  });
});

describe("issueQueryFromParams", () => {
  test("繰り返しとカンマ区切りを受け付け、ready は true か 1 で有効にする", () => {
    const params = new URLSearchParams(
      "workspace=api&workspace=WEB&status=todo,needs_clarification&label=bug&label=ui&project=検索&ready=1",
    );
    expect(issueQueryFromParams(params)).toEqual({
      workspace: ["API", "WEB"],
      status: ["todo", "needs_clarification"],
      project: "検索",
      label: ["bug", "ui"],
      ready: true,
    });
    expect(issueQueryFromParams(new URLSearchParams("ready=false"))).toEqual({});
    expect(codeOf(() => issueQueryFromParams(new URLSearchParams("ready=yes")))).toBe("INVALID_ARGS");
    expect(codeOf(() => issueQueryFromParams(new URLSearchParams("sort=title")))).toBe("INVALID_ARGS");
  });
});
