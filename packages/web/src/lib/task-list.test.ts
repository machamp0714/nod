import { describe, expect, test } from "bun:test";
import { toggleTaskAt } from "./task-list";

describe("タスクリストのチェックの付け外し", () => {
  const source = "前置き\n- [ ] 一つ目\n- [x] 二つ目\n";

  test("指定した位置の項目だけにチェックを付ける", () => {
    expect(toggleTaskAt(source, source.indexOf("- [ ] 一つ目"), true)).toBe("前置き\n- [x] 一つ目\n- [x] 二つ目\n");
  });

  test("チェックを外す", () => {
    expect(toggleTaskAt(source, source.indexOf("- [x] 二つ目"), false)).toBe("前置き\n- [ ] 一つ目\n- [ ] 二つ目\n");
  });

  test("番号付きの箇条書きや大文字の X も扱う", () => {
    expect(toggleTaskAt("1. [X] a", 0, false)).toBe("1. [ ] a");
    expect(toggleTaskAt("* [ ] a", 0, true)).toBe("* [x] a");
  });

  test("タスクリストの項目でなければ null を返す", () => {
    expect(toggleTaskAt("- 普通の項目", 0, true)).toBeNull();
  });
});
