import { describe, expect, test } from "bun:test";
import { workspaceNameOf } from "./decision";

describe("workspaceNameOf", () => {
  test("キーから Workspace の名前を引き、見つからなければキーを返す", () => {
    const workspaces = [{ key: "API", name: "api-server" }];
    expect(workspaceNameOf(workspaces, "API")).toBe("api-server");
    expect(workspaceNameOf(workspaces, "BLOG")).toBe("BLOG");
    expect(workspaceNameOf(undefined, "API")).toBe("API");
  });
});
