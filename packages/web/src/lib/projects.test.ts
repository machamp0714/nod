import { describe, expect, test } from "bun:test";
import type { ProjectStatus } from "../api/types";
import { filterProjects } from "./projects";

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
