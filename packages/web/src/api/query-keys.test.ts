import { describe, expect, test } from "bun:test";
import { issuePath, queryKeys } from "./query-keys";

describe("queryKeys", () => {
  test("一覧と詳細は2つ目の要素で分け、互いの前置にならない", () => {
    expect(queryKeys.issueList({ status: ["todo"] })).toEqual(["issues", "list", { status: ["todo"] }]);
    expect(queryKeys.issue("API-12")).toEqual(["issues", "detail", "API-12"]);
    expect(queryKeys.projectList({ includeClosed: true })).toEqual(["projects", "list", { includeClosed: true }]);
    expect(queryKeys.project(1)).toEqual(["projects", "detail", 1]);
  });
});

describe("issuePath", () => {
  test("Issue の ID を URL に埋め、操作があれば後ろに足す", () => {
    expect(issuePath("API-12")).toBe("/issues/API-12");
    expect(issuePath("API-12", "answer")).toBe("/issues/API-12/answer");
    expect(issuePath("a/b")).toBe("/issues/a%2Fb");
  });
});
