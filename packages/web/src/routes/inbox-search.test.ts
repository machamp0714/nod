import { expect, test } from "bun:test";
import { parseInboxSearch } from "./inbox-search";

test("allだけを履歴にしselectedと独立して正規化する", () => {
  expect(parseInboxSearch({ selected: "API-1", tab: "all" })).toEqual({ selected: "API-1", tab: "all" });
  expect(parseInboxSearch({ selected: "API-2", tab: "unknown" })).toEqual({ selected: "API-2" });
  expect(parseInboxSearch({ tab: ["all"] })).toEqual({});
});

test("notifications の通知タブを URL で保つ", () => {
  expect(parseInboxSearch({ selected: "API-1", tab: "notifications" })).toEqual({ selected: "API-1", tab: "notifications" });
});
