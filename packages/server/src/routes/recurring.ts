import {
  addRecurringIssue,
  getRecurringIssue,
  listRecurringIssues,
  type OpCtx,
  type RecurrenceCadence,
  type RecurringIssuePatch,
  removeRecurringIssue,
  runRecurringIssues,
  updateRecurringIssue,
} from "@nod/core";
import type { Hono } from "hono";
import {
  type Body,
  invalid,
  optBool,
  optInt,
  optNullableInt,
  optNullableString,
  optString,
  optStringArray,
  paramInt,
  readBody,
  reqString,
} from "../input";

const KEYS = [
  "title",
  "description",
  "template",
  "project",
  "labels",
  "priority",
  "assignee",
  "cadence",
  "weekday",
  "monthDay",
  "startDate",
  "timeZone",
  "enabled",
] as const;

// 値の検証（周期・曜日・日付・TZ など）は core で行う
function patchOf(body: Body): RecurringIssuePatch {
  return {
    title: optString(body, "title"),
    description: optNullableString(body, "description"),
    template: optNullableString(body, "template"),
    projectRef: optNullableString(body, "project"),
    labels: optStringArray(body, "labels"),
    priority: optInt(body, "priority"),
    assignee: optNullableString(body, "assignee"),
    cadence: optString(body, "cadence") as RecurrenceCadence | undefined,
    weekday: optNullableInt(body, "weekday"),
    monthDay: optNullableInt(body, "monthDay"),
    startDate: optString(body, "startDate"),
    timeZone: optString(body, "timeZone"),
    enabled: optBool(body, "enabled"),
  };
}

// 定期Issueの登録・変更・実行は web（書き手 me）から行う。LLM は CLI の list / run --dry-run で読むだけ
export function registerRecurringRoutes(app: Hono, me: OpCtx): void {
  const id = (value: string) => paramInt(value, "定期Issueの ID ");
  app.get("/api/workspaces/:key/recurring", (c) => c.json(listRecurringIssues(me.db, c.req.param("key"))));
  app.post("/api/workspaces/:key/recurring", async (c) => {
    const body = await readBody(c, KEYS);
    const patch = patchOf(body);
    const created = addRecurringIssue(me, c.req.param("key"), {
      ...patch,
      title: reqString(body, "title"),
      cadence: reqString(body, "cadence") as RecurrenceCadence,
      startDate: reqString(body, "startDate"),
    });
    return c.json(created, 201);
  });
  app.post("/api/workspaces/:key/recurring/run", async (c) => {
    const body = await readBody(c, ["dryRun"]);
    return c.json(runRecurringIssues(me, c.req.param("key"), { dryRun: optBool(body, "dryRun") ?? false }));
  });
  app.get("/api/workspaces/:key/recurring/:id", (c) =>
    c.json(getRecurringIssue(me.db, c.req.param("key"), id(c.req.param("id")))),
  );
  app.put("/api/workspaces/:key/recurring/:id", async (c) => {
    const body = await readBody(c, KEYS);
    return c.json(updateRecurringIssue(me, c.req.param("key"), id(c.req.param("id")), patchOf(body)));
  });
  app.delete("/api/workspaces/:key/recurring/:id", (c) =>
    c.json(removeRecurringIssue(me, c.req.param("key"), id(c.req.param("id")))),
  );
}
