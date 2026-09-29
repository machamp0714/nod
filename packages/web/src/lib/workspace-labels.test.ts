import { describe, expect, test } from "bun:test";
import { LABEL_COLORS, labelColor, labelColorChoices, singleWorkspace, statusName, statusNamesEditState, workspaceOfIssueId } from "./workspace-labels";

describe("ステータスの表示名", () => {
  test("Issue の Workspace の表示名を使い、未設定や Workspace 不明なら既定名", () => {
    const names = { API: { todo: "着手可" } };
    expect(statusName("todo", names, "API")).toBe("着手可");
    expect(statusName("todo", names, "NOD")).toBe("Todo");
    expect(statusName("done", names, "API")).toBe("Done");
    expect(statusName("todo", names, null)).toBe("Todo");
    expect(statusName("todo", undefined, "API")).toBe("Todo");
  });

  test("Issue の ID から Workspace のキーを取る", () => {
    expect(workspaceOfIssueId("API-12")).toBe("API");
  });

  test("Workspace を1つに絞ったときだけ、そのキーを返す", () => {
    expect(singleWorkspace(["api"])).toBe("API");
    expect(singleWorkspace(["API", "NOD"])).toBeNull();
    expect(singleWorkspace([])).toBeNull();
    expect(singleWorkspace(undefined)).toBeNull();
  });

  test("下書きは空と既定名を未設定として比べ、変わったときだけ保存できる", () => {
    expect(statusNamesEditState({}, {}).canSave).toBe(false);
    expect(statusNamesEditState({ todo: " Todo " }, {}).canSave).toBe(false);
    const edited = statusNamesEditState({ todo: " 着手可 " }, {});
    expect(edited.normalized).toEqual({ todo: "着手可" });
    expect(edited.canSave).toBe(true);
    expect(statusNamesEditState({ todo: "着手可" }, { todo: "着手可" }).canSave).toBe(false);
    expect(statusNamesEditState({}, { todo: "着手可" }).canSave).toBe(true);
    expect(statusNamesEditState({}, {}).empty).toBe(true);
  });

  test("30 文字を超える名前と、ほかのステータスと重なる名前は保存できない", () => {
    const long = statusNamesEditState({ todo: "a".repeat(31) }, {});
    expect(long.tooLong).toEqual(["todo"]);
    expect(long.canSave).toBe(false);
    const dup = statusNamesEditState({ todo: "Backlog" }, {});
    expect(dup.duplicated).toBe("Backlog");
    expect(dup.canSave).toBe(false);
  });
});

describe("ラベルの色", () => {
  test("先頭は灰色で、選択肢にない色は先頭に足す", () => {
    expect(LABEL_COLORS[0]!.value).toBe("#8A919E");
    expect(labelColorChoices("#2563EB")).toHaveLength(LABEL_COLORS.length);
    expect(labelColorChoices("#123456")[0]).toEqual({ value: "#123456", name: "#123456" });
  });
});

describe("表示名の適用", () => {
  test("Activity のステータス変更と Status の選択肢に渡した表示名を使う", async () => {
    const { describeActivity } = await import("./activity");
    const { statusChoices } = await import("./issue-edit");
    const names = { API: { todo: "着手可" } };
    const nameOf = (value: unknown) => (typeof value === "string" ? statusName(value as never, names, "API") : String(value));
    const line = describeActivity({ kind: "event", type: "status_changed", actor: "me", at: "2026-09-30T00:00:00Z", data: { from: "backlog", to: "todo" } } as never, nameOf);
    expect(line.text).toBe("me がステータスを Backlog から 着手可 に変えた");
    expect(statusChoices("todo", (s) => statusName(s, names, "API")).find((c) => c.value === "todo")?.label).toBe("着手可");
    expect(statusChoices("todo").find((c) => c.value === "todo")?.label).toBe("Todo");
  });
});

describe("ラベルの表示色（#117）", () => {
  const label = (workspaceKey: string, name: string, color: string) =>
    ({ workspaceKey, name, color, description: "", createdAt: "", updatedAt: "", issueCount: 0 }) as never;
  const labels = [label("API", "bug", "#B91C1C"), label("NOD", "bug", "#2563EB"), label("API", "perf", "#0D9768")];

  test("Issue の Workspace で定義した色を返す。同名でも別の Workspace の定義は使わない", () => {
    expect(labelColor(labels, "API", "bug")).toBe("#B91C1C");
    expect(labelColor(labels, "nod", "bug")).toBe("#2563EB");
    expect(labelColor(labels, "NOD", "perf")).toBeNull();
  });

  test("未定義のラベル・Workspace 不明・定義を読めていないときは null（既定の灰色）", () => {
    expect(labelColor(labels, "API", "security")).toBeNull();
    expect(labelColor(labels, "API", "Bug")).toBeNull();
    expect(labelColor(labels, null, "bug")).toBeNull();
    expect(labelColor(undefined, "API", "bug")).toBeNull();
  });
});
