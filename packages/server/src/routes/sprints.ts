import { getSprintPlanningStatus, getSprintFlow, getSprintIssueEligibility, getSprint, getUnresolvedSprintHistory, listSprints, sprintAnalytics, resolveCurrentSprints, type SprintClock, type OpCtx } from "@nod/core";
import { configureScrumWorkspace, getScrumWorkspace, createSprint, updateSprint, addSprintCandidate, listSprintCandidates,
  proposeSprintPlan, listSprintPlans, getSprintPlan, acceptSprintPlan, activateSprint, cancelSprint,
  type ConfigureScrumWorkspaceInput, type CreateSprintInput, type UpdateSprintInput, type AddSprintCandidateInput,
  type ProposeSprintPlanInput, type AcceptSprintPlanInput, type SprintMutation, type CancelSprintInput } from "@nod/core";
import type { Hono } from "hono";
import { paramInt, queryFlag, readBody } from "../input";

export function registerSprintRoutes(app: Hono, me: OpCtx, clock: SprintClock = {}): void {
  const mutation = ["expectedVersion", "requestKey"];
  app.get("/api/workspaces/:key/scrum", c => c.json(getScrumWorkspace(me.db,c.req.param("key"))));
  app.put("/api/workspaces/:key/scrum", async c => c.json(configureScrumWorkspace(me,c.req.param("key"),
    await readBody(c,[...mutation,"enabled","problem","productGoal","priorityRationale"]) as unknown as ConfigureScrumWorkspaceInput)));
  app.post("/api/sprints", async c => c.json(createSprint(me,
    await readBody(c,[...mutation,"workspaceKey","name","startDate","endDate","timezone","workingDays","replansSprintId"]) as unknown as CreateSprintInput),201));
  app.patch("/api/sprints/:ref", async c => c.json(updateSprint(me,c.req.param("ref"),
    await readBody(c,[...mutation,"name","startDate","endDate","timezone","workingDays"]) as unknown as UpdateSprintInput)));
  app.get("/api/sprints/:ref/candidates", c => c.json(listSprintCandidates(me.db,c.req.param("ref"))));
  app.post("/api/sprints/:ref/candidates", async c => c.json(addSprintCandidate(me,c.req.param("ref"),
    await readBody(c,[...mutation,"issueRef"]) as unknown as AddSprintCandidateInput),201));
  app.get("/api/sprints/:ref/plans", c => c.json(listSprintPlans(me.db,c.req.param("ref"))));
  app.get("/api/sprints/:ref/plans/:planId", c => c.json(getSprintPlan(me.db,c.req.param("ref"),c.req.param("planId"))));
  app.post("/api/sprints/:ref/plans", async c => c.json(proposeSprintPlan(me,c.req.param("ref"),
    await readBody(c,[...mutation,"goal","verificationMethod","items","definitionOfDone","constraints","changeReason"]) as unknown as ProposeSprintPlanInput),201));
  app.post("/api/sprints/:ref/plans/:planId/accept", async c => c.json(acceptSprintPlan(me,c.req.param("ref"),c.req.param("planId"),
    await readBody(c,[...mutation,"contentHash","agreementSource"]) as unknown as AcceptSprintPlanInput)));
  app.post("/api/sprints/:ref/activate", async c => c.json(activateSprint(me,c.req.param("ref"),
    await readBody(c,mutation) as unknown as SprintMutation,clock)));
  app.post("/api/sprints/:ref/cancel", async c => c.json(cancelSprint(me,c.req.param("ref"),
    await readBody(c,[...mutation,"reason"]) as unknown as CancelSprintInput,clock)));
  app.get("/api/sprints", c => {
    const workspace = c.req.query("workspaceId");
    return c.json(listSprints(me.db,{workspaceId:workspace === undefined ? undefined : paramInt(workspace,"Workspace ID")}));
  });
  app.get("/api/sprints/current", c => {
    const ids = c.req.queries("workspaceId");
    return c.json(resolveCurrentSprints(me.db, {
      clock, workspaceIds: ids?.map(id=>paramInt(id,"Workspace ID")),
      archived: queryFlag(c.req.query("archived"),"archived"),
    }));
  });
  app.get("/api/sprints/unresolved-history", c => c.json(getUnresolvedSprintHistory(me.db, {
    workspaceIds:c.req.queries("workspaceId")?.map(id=>paramInt(id,"Workspace ID")),
  })));
  app.get("/api/sprints/:ref/planning-status", c => c.json(getSprintPlanningStatus(me.db,c.req.param("ref"),clock)));
  app.get("/api/sprints/:ref/flow", c => c.json(getSprintFlow(me,c.req.param("ref"),c.req.query("planId"),clock)));
  app.get("/api/sprints/:ref/items/:itemId/eligibility", c => c.json(getSprintIssueEligibility(me,c.req.param("ref"),c.req.param("itemId"),clock)));
  app.get("/api/sprints/:ref/analytics", c => c.json(sprintAnalytics(me.db,c.req.param("ref"),{clock,timezone:c.req.query("tz")})));
  app.get("/api/sprints/:ref", c => c.json(getSprint(me.db,c.req.param("ref"))));
}
