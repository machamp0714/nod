import { describe, expect, test } from "bun:test";
import { createIssue } from "../src/ops/issues";
import { getTemplate, listTemplates, removeTemplate, saveTemplate } from "../src/ops/templates";
import { codeOf, setup } from "./helpers";

describe("テンプレート", () => {
  test("登録し、同じ名前なら本文を置き換え、名前の順に一覧する", () => {
    const { db } = setup();
    expect(saveTemplate(db, { name: "feature", body: "## 目的\n" }).created).toBe(true);
    saveTemplate(db, { name: "bug", body: "## 再現手順\n" });
    const replaced = saveTemplate(db, { name: "bug", body: "## 再現手順\n\n## 期待する動作\n" });
    expect(replaced).toMatchObject({ created: false, template: { name: "bug", body: "## 再現手順\n\n## 期待する動作\n" } });
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug", "feature"]);
  });

  test("名前や本文が空なら INVALID_ARGS、ないものは NOT_FOUND、消すと一覧から消える", () => {
    const { db } = setup();
    expect(codeOf(() => saveTemplate(db, { name: " ", body: "x" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => saveTemplate(db, { name: "bug", body: "\n" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => getTemplate(db, "none"))).toBe("NOT_FOUND");
    saveTemplate(db, { name: "bug", body: "x" });
    expect(removeTemplate(db, "bug").name).toBe("bug");
    expect(listTemplates(db)).toEqual([]);
    expect(codeOf(() => removeTemplate(db, "bug"))).toBe("NOT_FOUND");
  });
});

describe("createIssue の template", () => {
  test("本文を説明の初期値にし、description と同時なら INVALID_ARGS、ないテンプレートなら NOT_FOUND で連番を進めない", () => {
    const { db, ws, me } = setup();
    saveTemplate(db, { name: "bug", body: "## 再現手順\n" });
    expect(createIssue(me, { workspaceId: ws.id, title: "t", template: "bug" }).description).toBe("## 再現手順\n");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", template: "bug", description: "x" }))).toBe(
      "INVALID_ARGS",
    );
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", template: "none" }))).toBe("NOT_FOUND");
    expect(createIssue(me, { workspaceId: ws.id, title: "次" }).id).toBe("API-2");
  });
});
