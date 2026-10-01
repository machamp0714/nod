import { expect, test } from "bun:test";
import { parseOpenQuestionsSearch } from "./open-questions-search";

test("選択と絞り込みを URL から復元する", () => {
  expect(parseOpenQuestionsSearch({ selected: "TS-6", workspace: "ts", project: 12, q: "期限", group: "none" })).toEqual({
    selected: "TS-6",
    workspace: "TS",
    project: 12,
    q: "期限",
    group: "none",
  });
  expect(parseOpenQuestionsSearch({ q: 2026, project: "12" })).toEqual({ q: "2026", project: 12 });
});

test("不正な値は捨て、既定（Project ごと・絞り込みなし）にする", () => {
  expect(parseOpenQuestionsSearch({ selected: ["TS-6"], workspace: " ", project: "調査票", q: "  ", group: "project" })).toEqual({});
  expect(parseOpenQuestionsSearch({ project: 0 })).toEqual({});
  expect(parseOpenQuestionsSearch({ project: 1.5 })).toEqual({});
  expect(parseOpenQuestionsSearch({})).toEqual({});
});
