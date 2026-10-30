import type { Page, TestInfo } from "@playwright/test";
import type { Sprint, SprintDetail, SprintPlanResult } from "@nod/core";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "../fixtures";

export async function sprintApi<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`/api${path}`, { method, data });
  const body = await response.json();
  expect(response.ok(), `${method} ${path}: ${JSON.stringify(body)}`).toBe(true);
  return body as T;
}
export const todayUtc = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

// Sprintの準備に製品の公開HTTPだけを使う。active/合意/採択のfixture書込みは使わない。
export async function plannedSprint(page: Page, workspaceKey: string, refs: string[], options: {
  name?: string; candidates?: string[]; startDate?: string; endDate?: string; replansSprintId?: string;
} = {}) {
  const config = await sprintApi<{ version: number; enabled: boolean }>(page, "GET", `/workspaces/${workspaceKey}/scrum`);
  if (!config.enabled) await sprintApi(page, "PUT", `/workspaces/${workspaceKey}/scrum`, { expectedVersion: config.version, requestKey: crypto.randomUUID(), enabled: true, problem: "判断が散在する", productGoal: "判断を確認できる", priorityRationale: "待ち時間を減らす" });
  let sprint = await sprintApi<Sprint>(page, "POST", "/sprints", { expectedVersion: 0, requestKey: crypto.randomUUID(), workspaceKey,
    name: options.name ?? `${workspaceKey}の計画`, startDate: options.startDate ?? todayUtc(), endDate: options.endDate ?? todayUtc(1), timezone: "UTC", ...(options.replansSprintId ? { replansSprintId: options.replansSprintId } : {}) });
  const items = [];
  for (const ref of [...new Set([...refs, ...options.candidates ?? []])]) {
    const result = await sprintApi<{ sprint: Sprint; item: { id: string; sourceIssueKey: string } }>(page, "POST", `/sprints/${sprint.id}/candidates`, { expectedVersion: sprint.version, requestKey: crypto.randomUUID(), issueRef: ref });
    sprint = result.sprint;
    if (refs.includes(ref)) items.push({ itemId: result.item.id, contribution: `${ref}で判断を確認できる`, executionPlan: "要求を確認し実装と検証を進める" });
  }
  const input = { goal: `${workspaceKey}で判断を確認できる`, verificationMethod: "判断の発見から回答まで一巡する", items,
    definitionOfDone: [{ id: "確認", text: "公開操作で一巡を確認する" }], constraints: { executionScope: workspaceKey, maxParallel: 2, notes: "公開は既存の権限に従う" }, changeReason: "初回の計画" };
  const result = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${sprint.id}/plans`, { expectedVersion: sprint.version, requestKey: crypto.randomUUID(), ...input });
  return { ...result, input };
}
export async function acceptAndActivate(page: Page, planned: SprintPlanResult): Promise<Sprint> {
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
  return sprintApi<Sprint>(page, "POST", `/sprints/${ready.sprint.id}/activate`, { expectedVersion: ready.sprint.version, requestKey: crypto.randomUUID() });
}
export async function sprintDetail(page: Page, id: string) { return sprintApi<SprintDetail>(page, "GET", `/sprints/${id}`); }
export async function captureSprint(page: Page, name: string, info: TestInfo) {
  const path = process.env.NOD_E2E_EVIDENCE_DIR ? join(process.env.NOD_E2E_EVIDENCE_DIR, `${name}.png`) : info.outputPath(`${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  const scrolled = await page.locator("main").evaluate(el => { const old = el.scrollTop; el.scrollTop = 0; return old > 0; });
  if (scrolled) await page.screenshot({ path: path.replace(/\.png$/, "-top.png"), fullPage: true });
}
