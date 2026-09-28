import { describe, expect, test } from "bun:test";
import { VIEW_COLORS, viewNameError } from "./views";

describe("viewNameError", () => {
  const views = [
    { id: 1, name: "仕事" },
    { id: 2, name: "プライベート" },
  ];

  test("空の名前と、ほかの View と同じ名前を断る", () => {
    expect(viewNameError("  ", views, null)).toBe("名前を入力してください");
    expect(viewNameError(" 仕事 ", views, null)).toBe("View「仕事」はすでにあります");
  });

  test("自分と同じ名前と、新しい名前は通す", () => {
    expect(viewNameError("仕事", views, 1)).toBeNull();
    expect(viewNameError("新しい View", views, null)).toBeNull();
  });
});

describe("VIEW_COLORS", () => {
  test("色と名前は重ならない", () => {
    expect(new Set(VIEW_COLORS.map((c) => c.value)).size).toBe(VIEW_COLORS.length);
    expect(new Set(VIEW_COLORS.map((c) => c.label)).size).toBe(VIEW_COLORS.length);
  });
});

test("View 一覧を確認できない間は名前を検査済みにしない", () => {
  expect(viewNameError("仕事", undefined, null)).toBe("View の一覧を確認できるまでお待ちください");
});
