import { describe, expect, test } from "bun:test";
import { createIssue } from "../src/ops/issues";
import { getTemplate, listTemplates, removeTemplate, saveTemplate } from "../src/ops/templates";
import { codeOf, setup } from "./helpers";

describe("テンプレート", () => {
  test("登録し、同じ名前なら本文を置き換え、名前の順に一覧する", () => {
    const { db, me } = setup();
    expect(saveTemplate(me, { name: "feature", body: "## 目的\n" }).created).toBe(true);
    saveTemplate(me, { name: "bug", body: "## 再現手順\n" });
    const replaced = saveTemplate(me, { name: "bug", body: "## 再現手順\n\n## 期待する動作\n" });
    expect(replaced).toMatchObject({ created: false, template: { name: "bug", body: "## 再現手順\n\n## 期待する動作\n" } });
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug", "feature"]);
  });

  test("名前や本文が空なら INVALID_ARGS、ないものは NOT_FOUND、消すと一覧から消える", () => {
    const { db, me } = setup();
    expect(codeOf(() => saveTemplate(me, { name: " ", body: "x" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => saveTemplate(me, { name: "bug", body: "\n" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => getTemplate(db, "none"))).toBe("NOT_FOUND");
    saveTemplate(me, { name: "bug", body: "x" });
    expect(removeTemplate(me, "bug").name).toBe("bug");
    expect(listTemplates(db)).toEqual([]);
    expect(codeOf(() => removeTemplate(me, "bug"))).toBe("NOT_FOUND");
  });

  test("mode が create なら同じ名前を TEMPLATE_EXISTS で拒み、replace ならないものを NOT_FOUND で拒んで、どちらも書き込まない（#160）", () => {
    const { db, me } = setup();
    expect(saveTemplate(me, { name: "bug", body: "v1" }, "create").created).toBe(true);
    expect(codeOf(() => saveTemplate(me, { name: "bug", body: "v2" }, "create"))).toBe("TEMPLATE_EXISTS");
    expect(getTemplate(db, "bug").body).toBe("v1");
    expect(saveTemplate(me, { name: "bug", body: "v3" }, "replace")).toMatchObject({ created: false, template: { body: "v3" } });
    expect(codeOf(() => saveTemplate(me, { name: "none", body: "x" }, "replace"))).toBe("NOT_FOUND");
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug"]);
  });

  test("LLM は登録・置き換え・削除できず FORBIDDEN_FOR_LLM で何も変えない。一覧と本文は読める", () => {
    const { db, me, llm } = setup();
    saveTemplate(me, { name: "bug", body: "## 再現手順\n" });
    expect(codeOf(() => saveTemplate(llm, { name: "new", body: "x" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => saveTemplate(llm, { name: "bug", body: "x" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => saveTemplate(llm, { name: "new", body: "x" }, "create"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => saveTemplate(llm, { name: "bug", body: "x" }, "replace"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => removeTemplate(llm, "bug"))).toBe("FORBIDDEN_FOR_LLM");
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug"]);
    expect(getTemplate(db, "bug").body).toBe("## 再現手順\n");
  });
});

describe("createIssue の template", () => {
  test("本文を説明の初期値にし、description と同時なら INVALID_ARGS、ないテンプレートなら NOT_FOUND で連番を進めない", () => {
    const { db, ws, me } = setup();
    saveTemplate(me, { name: "bug", body: "## 再現手順\n" });
    expect(createIssue(me, { workspaceId: ws.id, title: "t", template: "bug" }).description).toBe("## 再現手順\n");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", template: "bug", description: "x" }))).toBe(
      "INVALID_ARGS",
    );
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", template: "none" }))).toBe("NOT_FOUND");
    expect(createIssue(me, { workspaceId: ws.id, title: "次" }).id).toBe("API-2");
  });
});
