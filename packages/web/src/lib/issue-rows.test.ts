import { describe, expect, test } from "bun:test";
import type { Issue, Workspace } from "../api/types";
import { buildRows } from "./issue-rows";

const issue = (id: string, answered = 0, total = 0) =>
  ({ id, workspace: id.split("-")[0], questionCount: { answered, total } }) as Issue;
const workspaces = [{ key: "API", name: "api-server" }] as Workspace[];

describe("buildRows", () => {
  test("未決事項の決定数、Ready、Workspace の名前を付ける", () => {
    const rows = buildRows([issue("API-9", 2, 6), issue("NOD-5")], [issue("NOD-5")], workspaces);
    expect(rows.map((r) => [r.issue.id, r.questions, r.ready, r.workspaceName])).toEqual([
      ["API-9", { decided: 2, total: 6 }, false, "api-server"],
      ["NOD-5", { decided: 0, total: 0 }, true, "NOD"],
    ]);
  });
});
