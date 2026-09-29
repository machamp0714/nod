import { expect, test } from "bun:test";
import { workspaceColorOf } from "./workspace-color";

const workspaces = [{ key: "API", color: "#7C5CFF" }, { key: "WEB", color: "#0D9768" }];

test("APIとWEBの保存値を使い、一覧順序によらず同じ色を返す", () => {
  expect(workspaceColorOf(workspaces, "API")).toBe("#7C5CFF");
  expect(workspaceColorOf([...workspaces].reverse(), "API")).toBe("#7C5CFF");
  expect(workspaceColorOf(workspaces, "WEB")).toBe("#0D9768");
});

test("未取得・未知キー・不正色はhash等で代用しない", () => {
  expect(workspaceColorOf(undefined, "API")).toBeUndefined();
  expect(workspaceColorOf([], "API")).toBeUndefined();
  expect(workspaceColorOf(workspaces, "BLOG")).toBeUndefined();
  for (const color of ["", "red", "#abcdef", "#GGGGGG", "var(--ws-a)", "#7C5CFF\n"]) {
    expect(workspaceColorOf([{ key: "API", color }], "API")).toBeUndefined();
  }
});
