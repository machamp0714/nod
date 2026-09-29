import { describe, expect, test } from "bun:test";
import { clearWorkspaceRules, getWorkspaceRules, RULES_MAX_LENGTH, setWorkspaceRules } from "../src/ops/workspace-rules";
import { codeOf, setup } from "./helpers";

describe("Workspace の作業規約", () => {
  test("未登録なら null を返す", () => {
    const { db, ws } = setup();
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
  });

  test("人が登録すると本文・更新日時・書き手を返し、前後の空白は落とす", () => {
    const { db, ws, me } = setup();
    const saved = setWorkspaceRules(me, ws.key, "\n- コミットは日本語で書く\n\n");
    expect(saved).toMatchObject({ workspaceKey: ws.key, body: "- コミットは日本語で書く", updatedBy: "me" });
    expect(saved!.updatedAt).toBeString();
    expect(getWorkspaceRules(db, ws.key)).toEqual(saved);
  });

  test("更新すると上書きされる", () => {
    const { db, ws, me } = setup();
    setWorkspaceRules(me, ws.key, "a");
    setWorkspaceRules(me, ws.key, "b");
    expect(getWorkspaceRules(db, ws.key)?.body).toBe("b");
  });

  test("パスや小文字のキーでも引ける", () => {
    const { db, ws, me } = setup();
    setWorkspaceRules(me, ws.path, "a");
    expect(getWorkspaceRules(db, ws.key.toLowerCase())?.body).toBe("a");
  });

  test("上限は 10,000 文字で、超えると INVALID_ARGS", () => {
    const { db, ws, me } = setup();
    expect(RULES_MAX_LENGTH).toBe(10000);
    expect(setWorkspaceRules(me, ws.key, "あ".repeat(10000))!.body.length).toBe(10000);
    expect(codeOf(() => setWorkspaceRules(me, ws.key, "あ".repeat(10001)))).toBe("INVALID_ARGS");
    expect(getWorkspaceRules(db, ws.key)?.body.length).toBe(10000);
  });

  test("空白だけを保存すると削除になる", () => {
    const { db, ws, me } = setup();
    setWorkspaceRules(me, ws.key, "a");
    expect(setWorkspaceRules(me, ws.key, "  \n")).toBeNull();
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
  });

  test("削除すると未登録に戻り、未登録の削除もエラーにしない", () => {
    const { db, ws, me } = setup();
    setWorkspaceRules(me, ws.key, "a");
    clearWorkspaceRules(me, ws.key);
    expect(getWorkspaceRules(db, ws.key)).toBeNull();
    clearWorkspaceRules(me, ws.key);
  });

  test("LLM は登録・更新・削除できず FORBIDDEN_FOR_LLM、読むことはできる", () => {
    const { db, ws, me, llm } = setup();
    expect(codeOf(() => setWorkspaceRules(llm, ws.key, "a"))).toBe("FORBIDDEN_FOR_LLM");
    setWorkspaceRules(me, ws.key, "a");
    expect(codeOf(() => setWorkspaceRules(llm, ws.key, "b"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => clearWorkspaceRules(llm, ws.key))).toBe("FORBIDDEN_FOR_LLM");
    expect(getWorkspaceRules(db, ws.key)?.body).toBe("a");
  });

  test("未登録の Workspace は NOT_FOUND", () => {
    const { db, me } = setup();
    expect(codeOf(() => getWorkspaceRules(db, "ZZZ"))).toBe("NOT_FOUND");
    expect(codeOf(() => setWorkspaceRules(me, "ZZZ", "a"))).toBe("NOT_FOUND");
    expect(codeOf(() => clearWorkspaceRules(me, "ZZZ"))).toBe("NOT_FOUND");
  });
});
