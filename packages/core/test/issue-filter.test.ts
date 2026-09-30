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
    expect(codeOf(() => validateIssueQuery({ owner: "me" }))).toBe("INVALID_ARGS");
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

describe("delegated", () => {
  test("true だけを残し、false は省き、真偽以外は INVALID_ARGS", () => {
    expect(validateIssueQuery({ delegated: true })).toEqual({ delegated: true });
    expect(validateIssueQuery({ delegated: false })).toEqual({});
    expect(codeOf(() => validateIssueQuery({ delegated: "yes" }))).toBe("INVALID_ARGS");
    expect(issueQueryFromParams(new URLSearchParams("delegated=1"))).toEqual({ delegated: true });
    expect(issueQueryFromParams(new URLSearchParams("delegated=false"))).toEqual({});
    expect(codeOf(() => issueQueryFromParams(new URLSearchParams("delegated=yes")))).toBe("INVALID_ARGS");
  });
});

describe("assignee", () => {
  test("文字列か配列を受け付け、前後の空白・空・重複を除き、none は未割り当てを指す", () => {
    expect(validateIssueQuery({ assignee: "me" })).toEqual({ assignee: ["me"] });
    expect(validateIssueQuery({ assignee: [" codex ", "me", "codex", ""] })).toEqual({ assignee: ["codex", "me"] });
    expect(validateIssueQuery({ assignee: ["NONE", " none "] })).toEqual({ assignee: ["none"] });
    expect(validateIssueQuery({ assignee: [] })).toEqual({});
    expect(validateIssueQuery({ assignee: "  " })).toEqual({});
  });

  test("担当の名前は大文字小文字を変えず、文字列以外は INVALID_ARGS", () => {
    expect(validateIssueQuery({ assignee: ["Claude-Code"] })).toEqual({ assignee: ["Claude-Code"] });
    expect(codeOf(() => validateIssueQuery({ assignee: [1] }))).toBe("INVALID_ARGS");
    expect(codeOf(() => validateIssueQuery({ assignee: true }))).toBe("INVALID_ARGS");
  });

  test("クエリパラメータは繰り返しとカンマ区切りを受け付ける", () => {
    expect(issueQueryFromParams(new URLSearchParams("assignee=me&assignee=claude-code"))).toEqual({ assignee: ["me", "claude-code"] });
    expect(issueQueryFromParams(new URLSearchParams("assignee=me,none"))).toEqual({ assignee: ["me", "none"] });
    expect(issueQueryFromParams(new URLSearchParams("assignee="))).toEqual({});
  });
});

test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
  "プロトタイプ名 %s のクエリも INVALID_ARGS にする", (key) => {
    expect(codeOf(() => issueQueryFromParams(new URLSearchParams([[key, "todo"]])))).toBe("INVALID_ARGS");
  },
);
