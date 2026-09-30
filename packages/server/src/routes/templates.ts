import { listTemplates, type OpCtx, removeTemplate, saveTemplate } from "@nod/core";
import type { Hono } from "hono";
import { readBody, reqString } from "../input";

// テンプレートは全 Workspace 共通。登録・本文の置き換え・削除は web（書き手 me）と CLI の人だけが行う（#150・#160）。
// 名前には / なども入りうるので、パスではなく本文で渡す
export function registerTemplateRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/templates", (c) => c.json(listTemplates(me.db)));
  app.post("/api/templates", async (c) => {
    const body = await readBody(c, ["name", "body"]);
    const { template } = saveTemplate(me, { name: reqString(body, "name").trim(), body: reqString(body, "body") }, "create");
    return c.json(template, 201);
  });
  app.post("/api/templates/update", async (c) => {
    const body = await readBody(c, ["name", "body"]);
    return c.json(saveTemplate(me, { name: reqString(body, "name"), body: reqString(body, "body") }, "replace").template);
  });
  app.post("/api/templates/remove", async (c) => {
    const body = await readBody(c, ["name"]);
    return c.json({ name: removeTemplate(me, reqString(body, "name")).name, removed: true });
  });
}
