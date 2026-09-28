import { describe, expect, test } from "bun:test";
import type { ProjectStatus, ProjectSummary } from "../api/types";
import { filterProjects, withWorkspaces } from "./projects";

const projects = (["planned", "started", "completed", "canceled"] as ProjectStatus[]).map((status) => ({ status }));

describe("filterProjects", () => {
  test("Active は planned と started、Completed は completed だけを出す", () => {
    expect(filterProjects(projects, "active").map((p) => p.status)).toEqual(["planned", "started"]);
    expect(filterProjects(projects, "completed").map((p) => p.status)).toEqual(["completed"]);
  });

  test("All は canceled も含めてすべて出す", () => {
    expect(filterProjects(projects, "all")).toHaveLength(4);
  });
});

describe("withWorkspaces", () => {
  test("Issue から Project ごとの Workspace のキーを集め、Issue のない Project は空にする", () => {
    const projects = [{ id: 1 }, { id: 2 }] as ProjectSummary[];
    const issues = [
      { workspace: "NOD", project: { id: 1, name: "a" } },
      { workspace: "API", project: { id: 1, name: "a" } },
      { workspace: "API", project: { id: 1, name: "a" } },
      { workspace: "BLOG", project: null },
    ];
    expect(withWorkspaces(projects, issues).map((p) => [p.id, p.workspaces])).toEqual([
      [1, ["API", "NOD"]],
      [2, []],
    ]);
  });
});
