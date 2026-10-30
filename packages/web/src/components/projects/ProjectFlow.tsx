import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useProjectFlow } from "../../api/hooks/projects";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import type { ProjectFlow, ProjectFlowNode, Status } from "../../api/types";
import { STATUS_META, TONE_COLORS } from "../../lib/meta";
import { statusName } from "../../lib/workspace-labels";
import { Button, Icon, type IconName, PageHeader, PageTitle, Segmented, Spacer, StatusIcon, ViewBar } from "../ui";
import l from "../issue-list/issue-list.module.css";
import { CARD_WIDTH, cardHeight, type FlowNodeState, flowNodeState, layoutFlow } from "./flow-layout";
import s from "./project-flow.module.css";

export type ProjectView = "list" | "flow";

// Project 詳細の「一覧 / フロー」の切り替え。切り替えると画面が組み直るため、押した側では選んだタブへフォーカスを戻す
export function ProjectViewSwitch({ value, onChange, focusOnMount }: { value: ProjectView; onChange: (next: ProjectView) => void; focusOnMount?: { current: boolean } }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focusOnMount?.current) return;
    focusOnMount.current = false;
    ref.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus();
  }, [focusOnMount]);
  return (
    <span ref={ref} className={s.switch}>
      <Segmented<ProjectView>
        label="Issue の表示"
        value={value}
        onChange={(next) => {
          if (next === value) return;
          if (focusOnMount) focusOnMount.current = true;
          onChange(next);
        }}
        items={[
          { value: "list", label: "一覧" },
          { value: "flow", label: "フロー" },
        ]}
      />
    </span>
  );
}

// design/nod.pen「Project詳細｜一覧（正本）」（DOM7I）・「Project詳細｜フロー」（R4bvo）の見出し行。
// 左に「Issue 一覧」と Project 内（アーカイブ済みを除き、完了・中止を含む）の件数、右に一覧とフローの切り替えを置き、一覧でもフローでも同じ部品を使う
export function ProjectIssuesBar({ count, viewSwitch }: { count: number; viewSwitch: ReactNode }) {
  return (
    <ViewBar className={s.viewBar}>
      <h2 className={s.listHeading}>
        Issue 一覧 <span className={s.listCount}>{count}</span>
      </h2>
      <Spacer />
      {viewSwitch}
    </ViewBar>
  );
}

// フロー表示のときの Project 詳細。一覧専用の絞り込み・Display・一括選択・プレビューは出さない。
// Header・概要・View Bar・本文・進捗報告の余白は一覧（IssueList）に合わせる
export function ProjectFlowPage({
  crumb,
  title,
  intro,
  heading,
  afterContent,
  projectId,
}: {
  crumb: ReactNode;
  title: string;
  intro: ReactNode;
  heading: ReactNode;
  afterContent: ReactNode;
  projectId: number;
}) {
  const flow = useProjectFlow(projectId, true);
  return (
    <div className={l.page}>
      <PageHeader>
        <span className={l.crumb}>{crumb}</span>
        <Icon name="chevron-right" size={12} color="var(--ink3)" />
        <PageTitle>{title}</PageTitle>
      </PageHeader>
      <div className={l.intro}>{intro}</div>
      {heading}
      <div className={s.body}>
        <ProjectFlowSection flow={flow} />
      </div>
      <div className={l.afterContent}>{afterContent}</div>
    </div>
  );
}

export function ProjectFlowSection({ flow, scopeNote = "Project 全体を表示しています（一覧の検索・絞り込みは適用されません）", beforeStart = false, externalLabel = "Project外", observedAt }: {
  flow: { data?: Pick<ProjectFlow, "nodes" | "edges">; error: unknown; isFetching: boolean; refetch: () => unknown };
  scopeNote?: string; beforeStart?: boolean; externalLabel?: string; observedAt?: string;
}) {
  return (
    <section className={s.section} aria-label="依存関係のフロー">
      <div className={s.notes}>
        <p className={s.explain}>矢印は前提となる Issue を示します。分岐した作業も、着手条件と並行上限の範囲で進めます。</p>
        <p className={s.scopeNote}>{scopeNote}</p>
      </div>
      {/* 読み直しに失敗しても、直前のグラフは消さずに失敗と再試行を添える */}
      {!!flow.error && (
        <div role="alert" className={s.error}>
          <p>フローを読み込めませんでした：{errorMessage(flow.error)}</p>{observedAt && <p>最後の確認：{observedAt}。現在の状態は確認できません。</p>}
          <Button size="sm" icon="refresh-cw" onClick={() => void flow.refetch()} disabled={flow.isFetching}>
            再試行
          </Button>
        </div>
      )}
      {flow.data ? (
        <FlowContent flow={flow.data} beforeStart={beforeStart} externalLabel={externalLabel} />
      ) : !flow.error && (
        <p role="status" className={s.message}>
          読み込み中…
        </p>
      )}
    </section>
  );
}

interface CardText {
  state: FlowNodeState;
  icon: ReactNode;
  label: string;
  prerequisite: string | null;
  cycleNext: string | null;
  outside: string | null;
}

const STATE_ICONS: Partial<Record<FlowNodeState, { icon: IconName; color: string; label: string }>> = {
  done: { icon: "circle-check", color: "var(--ready)", label: "完了" },
  in_progress: { icon: "circle-dot", color: "var(--accent)", label: "対応中" },
  ready: { icon: "circle", color: "var(--ink2)", label: "着手可能" },
  waiting: { icon: "lock", color: "var(--ask)", label: "前提待ち" },
};

function FlowContent({ flow, beforeStart = false, externalLabel = "Project外" }: { flow: Pick<ProjectFlow, "nodes" | "edges">; beforeStart?: boolean; externalLabel?: string }) {
  const names = useStatusNames();
  const layout = useMemo(() => layoutFlow(flow), [flow]);
  const byId = useMemo(() => new Map(flow.nodes.map((n) => [n.id, n])), [flow]);
  // url(#…) で参照するため、useId の記号を除く
  const markerId = `flow-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const nameOf = (status: Status, workspace: string) => statusName(status, names.data, workspace);
  const text = (node: ProjectFlowNode): CardText => {
    const state = flowNodeState(node);
    const meta = STATE_ICONS[state];
    const preds = layout.predecessors.get(node.id) ?? [];
    // 前提の状態を ID ごとに添える（完了・中止の前提は待ちの原因ではない）
    const predText = (id: string) => {
      const pred = byId.get(id);
      if (!pred) return id;
      return `${id} ${pred.status === "done" ? "完了" : pred.status === "canceled" ? "中止" : nameOf(pred.status, pred.workspace)}`;
    };
    return {
      state,
      icon: meta ? <Icon name={meta.icon} size={14} color={meta.color} /> : <StatusIcon status={node.status} />,
      label: beforeStart && !node.external ? "採択予定・開始前" : meta ? meta.label : nameOf(node.status, node.workspace),
      prerequisite: node.openBlockers.length > 0 ? `${node.openBlockers.join("・")} の完了後` : preds.length > 0 ? `前提：${preds.map(predText).join("・")}` : null,
      cycleNext: layout.cycleSuccessors.has(node.id) ? `後続（循環）：${layout.cycleSuccessors.get(node.id)!.join("・")}` : null,
      outside: node.external ? `${externalLabel} · ${node.project?.name ?? "Projectなし"} · ${node.workspaceName}` : null,
    };
  };

  const mainCount = flow.nodes.filter((n) => !n.external).length;
  if (mainCount === 0) return <p className={s.message}>Issue はありません</p>;
  const noDependencies = layout.cards.length === 0 && layout.cycle.length === 0;

  return (
    <>
      {!noDependencies && (
        <>
          <div className={s.canvas}>
            {layout.cards.length > 0 && (
              // 狭い画面では図の中だけを横にスクロールする。キーボードでもスクロールできるようフォーカスを受ける
              <div className={s.scroller} role="region" aria-label="依存関係の図" tabIndex={0}>
                <div className={s.graph} style={{ width: layout.width, height: layout.height }}>
                  <svg className={s.arrows} width={layout.width} height={layout.height} aria-hidden="true">
                    <defs>
                      <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                        <path d="M 0 1 L 10 5 L 0 9" className={s.arrowHead} />
                      </marker>
                    </defs>
                    {layout.edges.map((edge) => (
                      <path
                        key={`${edge.from}-${edge.to}`}
                        className={s.arrow}
                        d={edge.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")}
                        markerEnd={`url(#${markerId})`}
                      />
                    ))}
                  </svg>
                  {layout.cards.map((card) => (
                    <FlowCard key={card.node.id} node={card.node} text={text(card.node)} height={card.height} style={{ left: card.x, top: card.y }} />
                  ))}
                </div>
              </div>
            )}
            {layout.cycle.length > 0 && (
              <section className={s.frame} aria-label="循環している依存関係">
                <h3 className={`${s.frameHeading} ${s.cycleHeading}`}>
                  <Icon name="triangle-alert" size={14} color="var(--ask)" />
                  循環している依存関係 · {layout.cycle.length} 件
                </h3>
                <p role="note" className={s.frameNote}>
                  依存関係が循環しているため、順序を決められません。ブロックの関係を見直してください。
                </p>
                <ul className={s.cycleCards}>
                  {layout.cycle.map((node) => (
                    <li key={node.id}>
                      <FlowCard node={node} text={text(node)} height={cardHeight(node, true)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <ul className={s.legend} aria-label="凡例">
            {(["done", "in_progress", "ready", "waiting"] as const).map((state) => (
              <li key={state}>
                <Icon name={STATE_ICONS[state]!.icon} size={12} color={STATE_ICONS[state]!.color} />
                {STATE_ICONS[state]!.label}
              </li>
            ))}
          </ul>
        </>
      )}
      {layout.independent.length > 0 && <IndependentIssues nodes={layout.independent} text={text} />}
    </>
  );
}

// 独立 Issue は依存図の外で状態ごとに表示し、完了・中止だけを初期状態で折りたたむ。
function IndependentIssues({ nodes, text }: { nodes: ProjectFlowNode[]; text: (node: ProjectFlowNode) => CardText }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = [
    { key: "in_progress", label: "対応中", matches: (state: FlowNodeState) => state === "in_progress" },
    { key: "in_review", label: "In Review", matches: (state: FlowNodeState) => state === "in_review" },
    { key: "ready", label: "着手可能", matches: (state: FlowNodeState) => state === "ready" },
    { key: "other", label: "その他の未完了", matches: (state: FlowNodeState) => state === "other" || state === "waiting" },
    { key: "done", label: "完了", matches: (state: FlowNodeState) => state === "done" },
    { key: "canceled", label: "中止", matches: (state: FlowNodeState) => state === "canceled" },
  ];
  return (
    <section className={s.independentSection} aria-label="独立したIssue">
      <h3 className={s.independentHeading}>独立したIssue {nodes.length}件</h3>
      <p className={s.independentNote}>登録された依存関係のないIssueです。状態ごとにまとめて表示します。</p>
      {groups.map((group) => {
        const items = nodes.filter((node) => group.matches(flowNodeState(node)));
        if (items.length === 0) return null;
        const cards = (
          <ul className={s.independent}>
            {items.map((node) => {
              const t = text(node);
              const label = t.label === "採択予定・開始前" ? t.label : t.state === "canceled" ? "中止" : t.label;
              const color = STATE_ICONS[t.state]?.color ?? TONE_COLORS[STATUS_META[node.status].tone].fg;
              return (
                <li key={node.id}>
                  <Link to="/issues/$issueId" params={{ issueId: node.id }} className={s.independentCard} aria-label={`${node.id} ${node.title}、${label}`}>
                    <span className={s.independentMeta}>
                      <span className={s.mono}>{node.id}</span>
                      <span className={s.independentState} style={{ color }}>{t.icon}{label}</span>
                    </span>
                    <span className={s.cardTitle} title={node.title}>{node.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        );
        return group.key === "done" || group.key === "canceled" ? (
          <details
            key={group.key}
            className={s.closedGroup}
            open={expanded[group.key] ?? false}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((current) => ({ ...current, [group.key]: open }));
            }}
          >
            <summary className={s.groupToggle} style={{ color: group.key === "done" ? "var(--ready)" : "var(--ink2)" }}>
              <Icon name="chevron-right" size={14} />
              {group.label} {items.length}件を{expanded[group.key] ? "非表示" : "表示"}
            </summary>
            {cards}
          </details>
        ) : (
          <section key={group.key} className={s.independentGroup} aria-label={group.label}>
            <h4 className={s.groupHeading}>{group.label} {items.length}</h4>
            {cards}
          </section>
        );
      })}
    </section>
  );
}

// フローのカード。Issue 詳細へのリンクで、色だけに頼らずアイコンと文字で状態を示す
function FlowCard({ node, text, height, style }: { node: ProjectFlowNode; text: CardText; height: number; style?: { left: number; top: number } }) {
  const name = [`${node.id} ${node.title}`, text.label, text.prerequisite, text.cycleNext, text.outside].filter(Boolean).join("、");
  return (
    <Link
      to="/issues/$issueId"
      params={{ issueId: node.id }}
      className={[s.card, s[text.state], node.external && s.external, style && s.placed].filter(Boolean).join(" ")}
      style={{ width: CARD_WIDTH, height, ...style }}
      aria-label={name}
    >
      <span className={s.cardId}>
        {text.icon}
        <span className={s.mono}>{node.id}</span>
      </span>
      <span className={s.cardTitle} title={node.title}>
        {node.title}
      </span>
      <span className={s.stateLabel}>{text.label}</span>
      {text.prerequisite && <span className={s.line} title={text.prerequisite}>{text.prerequisite}</span>}
      {text.cycleNext && <span className={s.line} title={text.cycleNext}>{text.cycleNext}</span>}
      {text.outside && <span className={s.line} title={text.outside}>{text.outside}</span>}
    </Link>
  );
}
