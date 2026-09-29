import { parseLimit, recentSummary, type Summary, SUMMARY_DEFAULT_LIMIT, SUMMARY_DEFAULT_SINCE, type SummaryItem } from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace } from "../context";
import { print, statusText } from "../output";

interface SummaryOptions {
  since?: string;
  project?: string;
  limit?: string;
  includeArchived?: boolean;
  allWorkspaces?: boolean;
}

// 記録時刻をこのマシンのローカル時刻で YYYY-MM-DD HH:mm にする
export function localMinute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

function formatItem(i: SummaryItem): string {
  const who = i.actorKind === "human" ? "人" : `LLM ${i.actor}`;
  const parts = [localMinute(i.at), i.issueId, i.title, `[${statusText(i.status, i.issueId)}]`, who];
  if (i.assignee && i.assignee !== i.actor) parts.push(`担当 ${i.assignee}`);
  if (i.archived) parts.push("アーカイブ済み");
  const line = `  ${parts.join("  ")}`;
  return i.detail && i.kind !== "started" ? `${line}\n    ${oneLine(i.detail)}` : line;
}

export function formatSummary(s: Summary): string {
  const head = [
    `${localMinute(s.since)}〜${localMinute(s.until)} の動き`,
    `合計 ${s.totals.total}（人 ${s.totals.human} / LLM ${s.totals.llm}）`,
  ];
  const sections = s.sections.filter((x) => x.total > 0);
  if (!sections.length) return [...head, "この期間の動きはありません"].join("\n");
  return [
    ...head,
    ...sections.flatMap((x) => [
      "",
      `${x.label} ${x.total}（人 ${x.human} / LLM ${x.llm}）`,
      ...x.items.map(formatItem),
      ...(x.more ? [`  他${x.more}件`] : []),
    ]),
  ].join("\n");
}

export function registerSummaryCommand(program: Command): void {
  program
    .command("summary")
    .description("期間内の動き（完了・着手・レビュー提出・差し戻し・質問/回答・ブロッカー・新規起票・アーカイブ）を種類別にまとめる。読み取り専用")
    .option("--since <期間>", `24h・7d・2w のような直近の長さか ISO 日時（既定は ${SUMMARY_DEFAULT_SINCE}、最長 90 日）`)
    .option("--project <project>", "Project の名前か ID")
    .option("--limit <n>", `種類ごとに並べる件数（既定は ${SUMMARY_DEFAULT_LIMIT}、最大 200）。超えた分は「他N件」`)
    .option("--include-archived", "アーカイブ済み Issue の動きも含める")
    .option("--all-workspaces", "すべての Workspace をまとめる（既定は現在の Workspace）")
    .action(
      act((cli, cmd) => {
        const o = cmd.opts() as SummaryOptions;
        const result = recentSummary(cli.db, {
          since: o.since,
          project: o.project,
          limit: o.limit === undefined ? undefined : parseLimit(o.limit),
          includeArchived: o.includeArchived,
          workspace: o.allWorkspaces ? undefined : [currentWorkspace(cli, cmd).key],
        });
        print(cli, result, () => formatSummary(result));
      }),
    );
}
