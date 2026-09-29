import {
  addWorkspaceLabel,
  getStatusNames,
  listAllStatusNames,
  listAllWorkspaceLabels,
  listWorkspaceLabels,
  type OpCtx,
  removeWorkspaceLabel,
  setStatusNames,
  updateWorkspaceLabel,
} from "@nod/core";
import type { Hono } from "hono";
import { invalid, optString, readBody, reqString } from "../input";

// ラベル定義とステータスの表示名は web（書き手 me）からだけ変更する。LLM は CLI で読むだけ。
// ラベル名には / なども入りうるので、パスではなく本文で渡す
export function registerWorkspaceLabelRoutes(app: Hono, me: OpCtx): void {
  app.get("/api/labels", (c) => c.json(listAllWorkspaceLabels(me.db)));
  app.get("/api/workspaces/:key/labels", (c) => c.json(listWorkspaceLabels(me.db, c.req.param("key"))));
  app.post("/api/workspaces/:key/labels", async (c) => {
    const body = await readBody(c, ["name", "color", "description"]);
    const label = addWorkspaceLabel(me, c.req.param("key"), {
      name: reqString(body, "name"),
      color: reqString(body, "color"),
      description: optString(body, "description"),
    });
    return c.json(label, 201);
  });
  app.post("/api/workspaces/:key/labels/update", async (c) => {
    const body = await readBody(c, ["name", "newName", "color", "description"]);
    return c.json(
      updateWorkspaceLabel(me, c.req.param("key"), reqString(body, "name"), {
        name: optString(body, "newName"),
        color: optString(body, "color"),
        description: optString(body, "description"),
      }),
    );
  });
  app.post("/api/workspaces/:key/labels/remove", async (c) => {
    const body = await readBody(c, ["name"]);
    return c.json(removeWorkspaceLabel(me, c.req.param("key"), reqString(body, "name")));
  });

  app.get("/api/status-names", (c) => c.json(listAllStatusNames(me.db)));
  app.get("/api/workspaces/:key/status-names", (c) => c.json(getStatusNames(me.db, c.req.param("key"))));
  app.put("/api/workspaces/:key/status-names", async (c) => {
    const body = await readBody(c, ["names"]);
    const names = body.names;
    if (typeof names !== "object" || names === null || Array.isArray(names)) {
      throw invalid("names はステータスから表示名へのオブジェクトで指定してください");
    }
    for (const [status, name] of Object.entries(names)) {
      if (name !== null && typeof name !== "string") throw invalid(`names.${status} は文字列か null で指定してください`);
    }
    return c.json(setStatusNames(me, c.req.param("key"), names as Record<string, string | null>));
  });
}
