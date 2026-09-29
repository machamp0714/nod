import { describe, expect, test } from "bun:test";
import type { TriageProposal } from "../api/types";
import { parseLabels } from "./issue-edit";
import { applyAcceptProposal, proposalAttributes, proposalBadge, proposalsHeading } from "./triage-proposal";

function proposal(over: Partial<TriageProposal>): TriageProposal {
  return {
    issueId: "API-3", actor: "claude-code", decision: "accept", duplicateOf: null, labels: [], assignee: null, priority: null,
    project: null, reason: null, createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", ...over,
  };
}

describe("proposalBadge", () => {
  test("推奨の種類ごとにアイコン・文言・色を返し、重複は元の ID を添える", () => {
    expect(proposalBadge(proposal({}))).toEqual({ icon: "check", text: "受け入れ", tone: "ready" });
    expect(proposalBadge(proposal({ decision: "duplicate", duplicateOf: "API-1" }))).toEqual({ icon: "copy", text: "重複 API-1", tone: "gate" });
    expect(proposalBadge(proposal({ decision: "decline" }))).toEqual({ icon: "x", text: "却下", tone: "fail" });
  });
});

describe("applyAcceptProposal", () => {
  const form = { projectRef: "", priority: 0, labels: ["search"], assignee: "" };
  test("指定のある項目だけ置き換え、ラベルは重ねずに足す", () => {
    const p = proposal({ project: { id: 7, name: "検索" }, priority: 3, labels: ["bug", "search"], assignee: "codex" });
    expect(applyAcceptProposal(form, p)).toEqual({ projectRef: "7", priority: 3, labels: ["search", "bug"], assignee: "codex" });
  });
  test("反映したラベルは入力欄に連結して分け直しても分割されない（空白・読点を含む名前は core が記録時に拒否する）", () => {
    const p = proposal({ labels: ["good-first-issue", "検索改善", "v2.0", "a_b"] });
    const next = applyAcceptProposal({ ...form, labels: [] }, p);
    expect(parseLabels(next.labels.join(", "), [])).toEqual(p.labels);
  });
  test("何も指定のない提案はフォームを変えない", () => {
    expect(applyAcceptProposal(form, proposal({}))).toEqual(form);
  });
});

describe("proposalAttributes", () => {
  test("指定のある属性だけを受け入れ設定と同じ順で返す", () => {
    const p = proposal({ assignee: "codex", labels: ["bug", "perf"], priority: 3, project: { id: 1, name: "検索" } });
    expect(proposalAttributes(p).map((a) => [a.label, a.value])).toEqual([
      ["Project", "検索"], ["Priority", "Medium"], ["Labels", "bug, perf"], ["Assignee", "codex"],
    ]);
    expect(proposalAttributes(proposal({ decision: "decline" }))).toEqual([]);
  });
});

describe("proposalsHeading", () => {
  test("LLM の提案だけなら「LLM の提案」、me の提案を含むなら「提案」", () => {
    expect(proposalsHeading([proposal({}), proposal({ actor: "codex" })])).toBe("LLM の提案");
    expect(proposalsHeading([proposal({}), proposal({ actor: "me" })])).toBe("提案");
    expect(proposalsHeading([proposal({ actor: "me" })])).toBe("提案");
  });
});
