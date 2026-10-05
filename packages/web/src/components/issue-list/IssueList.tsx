import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentState, Status } from "../../api/types";
import { AGENT_STATE_META, BOARD_STATUSES, priorityMeta, TONE_COLORS } from "../../lib/meta";
import { defaultIssueColumns } from "../../routes/search";
import type { IssueColumn, IssueGroupKey, IssueListSearch } from "../../routes/search";
import { AgentAvatar, Icon, IconButton, PageHeader, PageTitle, Segmented, Spacer, StatusIcon, ViewBar, WorkspaceBadge } from "../ui";
import { pruneSelection, type Selection, selectAllState, toggleAll, toggleSelection } from "../../lib/bulk-selection";
import { AgentStateDot } from "./AgentStateDot";
import { BulkActionBar } from "./BulkActionBar";
import { DisplayPopover, GROUP_NAMES } from "./DisplayPopover";
import { IssueBoard } from "./IssueBoard";
import { useCycles } from "../../api/hooks/cycles";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { cycleLabel } from "../../lib/cycles";
import { useDraftText } from "../../lib/draft-text";
import { singleWorkspace, statusName } from "../../lib/workspace-labels";
import { countRows, effectiveGrouping, filterRows, groupRows, type ListTab, type RowGroup, sortRows } from "./issue-list";
import s from "./issue-list.module.css";
import { IssueTable } from "./IssueTable";
import { PreviewPane } from "./PreviewPane";
import type { IssueListRow } from "./types";

export interface IssueListProps {
  crumb?: ReactNode;
  title: string;
  titleIcon?: ReactNode; // タイトルの左に置く印（View の色）
  titleNote?: ReactNode; // タイトルの右に置く注記（View の「変更あり」）
  intro?: ReactNode;
  actions?: ReactNode; // Header の右に置くボタン（View として保存、View の変更など）
  filterBar?: ReactNode; // 絞り込み条件のチップの行。条件を足すパネル（<details>）があれば、View Bar の Filter のボタンから開ける
  rows: IssueListRow[];
  loading?: boolean;
  error?: string | null;
  search: IssueListSearch;
  onSearchChange: (patch: IssueListSearch) => void;
  // Status の見出しに表示名を使う Workspace。省略時は Workspace の絞り込みが1つのときだけ使う
  statusWorkspace?: string | null;
  // My issues：タブは担当（me と LLM の担当）だけにする。Status でまとめるのが既定
  mine?: boolean;
  // 全行が同じ値になるため既定から外す列（Project 詳細の Project）。URL で列を明示したときは出す
  sameValueColumn?: IssueColumn;
  // ページごとに保存した表示設定を消す（#218）。View では渡さない
  onResetDisplay?: () => void;
  resetDisplayDisabled?: boolean;
}

// プレビュー中に表から外す列。design/nod.pen「Issues｜プレビュー」（A3zK7）は Project と Workspace を外し、優先度・担当・更新日時を残す。
// 表示設定で足した列（未決事項・PR・見積もり・期限）も、題名の幅を保つため外す（#196）
const PREVIEW_HIDDEN_COLUMNS: readonly IssueColumn[] = ["workspace", "project", "questions", "pr", "estimate", "dueDate"];

// design/nod.pen「11 Issues」（O7KCp3）：Header、View Bar（タブと、検索、Filter、Display のアイコンボタン）、Filters の行、一覧。
// 件数はタブに出す。グループ化、並び順、表示列、List と Board の切り替えは Display のポップオーバーにまとめる。
// Project 詳細、Cycle 詳細、Issues、My issues、Views で共通に使い、表示する Issue の範囲（rows）だけが違う。
export function IssueList({
  crumb,
  title,
  titleIcon,
  titleNote,
  intro,
  actions,
  filterBar,
  rows,
  loading = false,
  error = null,
  search,
  onSearchChange,
  statusWorkspace,
  mine = false,
  sameValueColumn,
  onResetDisplay,
  resetDisplayDisabled,
}: IssueListProps) {
  const statusNames = useStatusNames();
  const namesWorkspace = statusWorkspace === undefined ? singleWorkspace(search.workspace) : statusWorkspace;
  const nameOfStatus = (status: Status) => statusName(status, statusNames.data, namesWorkspace);
  // Cycle のグループは「名前（状態）」を見出しにし、開始日の順に並べる
  const cycles = useCycles();
  const cycleInfo = (id: number) => {
    const cycle = cycles.data?.find((c) => c.id === id);
    return cycle && { label: cycleLabel(cycle), rank: cycle.startDate, current: cycle.state === "current" };
  };
  const tab: ListTab = mine ? "mine" : (search.tab ?? "all");
  const layout = search.layout ?? "list";
  const q = search.q ?? "";
  const counts = countRows(rows);
  const visible = sortRows(filterRows(rows, { tab, q, showCompleted: search.showCompleted, showChildren: search.showChildren }), search.sort, search.direction);
  const preview = search.preview;
  // プレビュー中は一覧の幅が狭くなるため、PREVIEW_HIDDEN_COLUMNS（Project・Workspace とチップで足した列）を隠して題名の幅を保つ（#174・#196）
  // 表示設定の列はユーザーの設定のまま扱い、表に渡す列だけを減らす
  const columns = search.columns ?? defaultIssueColumns(sameValueColumn);
  const tableColumns = preview ? columns.filter((column) => !PREVIEW_HIDDEN_COLUMNS.includes(column)) : columns;
  const { groupBy, subGroupBy } = effectiveGrouping(search, layout, mine);
  const groups = groupBy
    ? groupRows(layout === "board" ? visible.filter((r) => BOARD_STATUSES.includes(r.issue.status)) : visible, groupBy, subGroupBy, nameOfStatus, cycleInfo)
    : [];
  // プレビューを閉じたら、開いた要素（なければその行のリンク）へフォーカスを戻す
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef(preview);
  useEffect(() => {
    const closed = shown.current;
    shown.current = preview;
    if (!closed || preview) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const row = document.querySelector(`[data-issue-row="${CSS.escape(closed)}"]`);
    const back = opener.current?.isConnected && opener.current.closest(`[data-issue-row="${CSS.escape(closed)}"]`) ? opener.current : row?.querySelector<HTMLElement>("a");
    back?.focus();
  }, [preview]);
  const onPreview = useCallback((id: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onSearchChange({ preview: id });
  }, [onSearchChange]);
  const closePreview = useCallback(() => onSearchChange({ preview: undefined }), [onSearchChange]);
  const titles = useMemo(() => new Map(rows.map((r) => [r.issue.id, r.issue.title])), [rows]);
  const workspaceNames = useMemo(() => new Map(rows.map((r) => [r.issue.workspace, r.workspaceName])), [rows]);
  const delegated = tab === "delegated";
  // ラベルのグループでは同じ行が何度も出るため、描画順で最初の表だけに現在のプレビューを示させる
  let currentShown = false;
  // 表は positions と同じ順に描くので、描いた行数を数えて各表の先頭行の表示位置にする
  let offset = 0;
  const table = (tableRows: IssueListRow[]) => {
    const markCurrent = !currentShown && tableRows.some((r) => r.issue.id === preview);
    if (markCurrent) currentShown = true;
    const selection = rowSelection && { ...rowSelection, offset };
    offset += tableRows.length;
    return <IssueTable rows={tableRows} columns={tableColumns} previewId={preview} markCurrent={markCurrent} onPreview={onPreview} showAgentState={delegated || tab === "mine"} selection={selection} />;
  };
  // 一括編集の選択。URL には残さず、List 表示で見えている Issue だけを選べる
  const [selection, setSelection] = useState<Selection>({ ids: NO_SELECTION, anchor: null });
  const [toast, setToast] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectable = layout === "list";
  // 表示順の ID。positions はラベルのグループで同じ Issue が何度も出る並びのまま、order は1回ずつ
  const positions = useMemo(() => (groupBy ? groups.flatMap(rowsOf) : visible).map((r) => r.issue.id), [groupBy, groups, visible]);
  const order = useMemo(() => [...new Set(positions)], [positions]);
  const selectedIds = selectable ? pruneSelection(selection.ids, order) : NO_SELECTION;
  useEffect(() => {
    if (selectedIds !== selection.ids) setSelection((prev) => ({ ...prev, ids: selectedIds }));
  }, [selectedIds, selection.ids]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  const selectedIssues = useMemo(
    () => [...new Map(rows.filter((r) => selectedIds.has(r.issue.id)).map((r) => [r.issue.id, r.issue])).values()],
    [rows, selectedIds],
  );
  const knownLabels = useMemo(() => [...new Set(rows.flatMap((r) => r.issue.labels))], [rows]);
  const onToggleRow = useCallback((at: number, shift: boolean) => setSelection((prev) => toggleSelection(prev, positions, at, shift)), [positions]);
  const toggleMany = (ids: string[]) => setSelection((prev) => ({ ...prev, ids: toggleAll(prev.ids, ids) }));
  const clearSelection = () => setSelection({ ids: NO_SELECTION, anchor: null });
  const rowSelection = selectable ? { ids: selectedIds, onToggle: onToggleRow } : undefined;
  // 委任中タブの担当でのまとめは effectiveGrouping が表示時に決める（URL には書かない）
  const selectTab = (next: ListTab) => onSearchChange({ tab: next === "mine" ? "all" : next });
  // 検索欄は View Bar のアイコンボタンから開く。検索語があるあいだは開いたままにする
  const [searching, setSearching] = useState(false);
  const searchText = useDraftText(q, (next) => onSearchChange({ q: next }));
  const searchOpen = searching || q !== "";
  const searchButton = useRef<HTMLButtonElement>(null);
  const refocusSearch = useRef(false);
  useEffect(() => {
    if (searchOpen || !refocusSearch.current) return;
    refocusSearch.current = false;
    searchButton.current?.focus();
  }, [searchOpen]);
  // Filter のボタンは、Filters の行にある条件のパネル（FilterBar の <details>）を開く。パネルがない画面では出さない
  const filters = useRef<HTMLDivElement>(null);
  const [hasFilterPanel, setHasFilterPanel] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  useEffect(() => {
    const panel = filters.current?.querySelector("details");
    setHasFilterPanel(!!panel);
    setFilterPanelOpen(!!panel?.open);
  });
  // パネルは「Filter」の見出しからも開閉できるので、toggle を聞いてボタンの aria-expanded を合わせる（toggle は伝播しないため capture で受ける）
  useEffect(() => {
    const row = filters.current;
    if (!row) return;
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement) setFilterPanelOpen(event.target.open);
    };
    row.addEventListener("toggle", onToggle, true);
    return () => row.removeEventListener("toggle", onToggle, true);
  }, [hasFilterPanel]);
  const toggleFilterPanel = () => {
    const panel = filters.current?.querySelector("details");
    if (!panel) return;
    panel.open = !panel.open;
    // 開いたときだけパネルの見出しへフォーカスを移す。閉じたときはボタンに残す
    if (panel.open) panel.querySelector("summary")?.focus();
  };
  // グループのない Board は、Main の残りの高さいっぱいに列を伸ばし、Board の中でスクロールする。
  // 概要（intro）がある画面（Project 詳細、Cycle 詳細）では Main の高さに固定せず、Board を内容の高さまで伸ばして Main だけをスクロールさせる
  const fill = layout === "board" && !groupBy && !intro;

  return (
    <div className={fill ? `${s.split} ${s.splitFill}` : s.split}>
    <div
      className={s.page}
      onKeyDown={(event) => {
        // Escape で一括編集の選択を解く。入力欄とメニューの Escape はそれぞれに任せる
        if (event.key !== "Escape" || event.defaultPrevented || selectedIds.size === 0) return;
        if ((event.target as HTMLElement).closest("input:not([type=checkbox]), textarea, select, dialog, [role=dialog]")) return;
        event.preventDefault();
        clearSelection();
      }}
    >
      <PageHeader>
        {crumb && (
          <>
            <span className={s.crumb}>{crumb}</span>
            <Icon name="chevron-right" size={12} color="var(--ink3)" />
          </>
        )}
        {titleIcon}
        <PageTitle>{title}</PageTitle>
        {titleNote}
        <Spacer />
        {actions && <div className={s.actions}>{actions}</div>}
      </PageHeader>
      {intro && <div className={s.intro}>{intro}</div>}
      <ViewBar>
        <Segmented<ListTab>
          label="絞り込み"
          value={tab}
          onChange={selectTab}
          items={mine ? [
            { value: "mine", label: `担当 ${counts.mine}` },
          ] : [
            { value: "all", label: `All ${counts.all}` },
            { value: "ready", label: `Ready ${counts.ready}` },
            { value: "needs_clarification", label: `${nameOfStatus("needs_clarification")} ${counts.needsClarification}` },
            { value: "delegated", label: `委任中 ${counts.delegated}` },
          ]}
        />
        <Spacer />
        {searchOpen ? (
          <label className={s.search}>
            <Icon name="search" />
            <input
              className={s.searchInput}
              aria-label="検索"
              placeholder="ID・タイトル・説明で検索"
              value={searchText.value}
              // ボタンから開いたときだけフォーカスを移す（検索語つきの URL を開いたときは動かさない）
              autoFocus={searching}
              onChange={searchText.onChange}
              // 検索語を消しているあいだは閉じず、空のままフォーカスが外れたら閉じる
              onFocus={() => setSearching(true)}
              onBlur={() => {
                searchText.onBlur();
                setSearching(false);
              }}
              onKeyDown={(event) => {
                // 空の検索欄の Escape は、欄を閉じてボタンへ戻る
                if (event.key !== "Escape" || searchText.value !== "" || event.nativeEvent.isComposing) return;
                refocusSearch.current = true;
                setSearching(false);
              }}
            />
          </label>
        ) : (
          <IconButton ref={searchButton} icon="search" label="検索を開く" bordered onClick={() => setSearching(true)} />
        )}
        {hasFilterPanel && <IconButton icon="list-filter" label="絞り込み条件を開く" bordered aria-expanded={filterPanelOpen} onClick={toggleFilterPanel} />}
        <DisplayPopover search={search} layout={layout} groupBy={groupBy} subGroupBy={subGroupBy} columns={columns} onSearchChange={onSearchChange} onReset={onResetDisplay} resetDisabled={resetDisplayDisabled} />
      </ViewBar>
      {(selectable || filterBar) && (
        // design/nod.pen「Issues｜一括編集」：表示中の全選択は Filters の行の左端に置く
        <div className={s.filters} ref={filters}>
          {selectable && <SelectAllBox ids={order} label="表示中の Issue をすべて選択" selected={selectedIds} onChange={toggleMany} inputRef={selectAllRef} />}
          {filterBar}
        </div>
      )}
      <div className={fill ? `${s.body} ${s.bodyFill}` : s.body}>
        {error ? (
          <p role="alert" className={`${s.message} ${s.messageError}`}>
            {error}
          </p>
        ) : loading ? (
          <p role="status" className={s.message}>
            読み込み中…
          </p>
        ) : delegated && counts.delegated === 0 ? (
          <div className={s.emptyDelegated}>
            <Icon name="bot" size={24} color="var(--ink3)" />
            LLM に委任中の Issue はありません
          </div>
        ) : tab === "mine" && counts.mine === 0 ? (
          // Pencil「My issues｜担当 空状態（#162）」
          <div className={s.emptyDelegated}>
            <Icon name="circle-user" size={24} color="var(--ink3)" />
            担当している Issue はありません
          </div>
        ) : groupBy ? (
          groups.length === 0 ? <p className={s.message}>該当する Issue はありません</p> : (
            groups.map((group) => (
              <section key={group.key} className={s.workspaceGroup} aria-label={`${GROUP_NAMES[groupBy]} ${group.label}`}>
                <GroupHeading
                  by={groupBy}
                  group={group}
                  delegated={delegated}
                  select={selectable ? <SelectAllBox ids={idsOf(rowsOf(group))} label={`${GROUP_NAMES[groupBy]} ${group.label} の Issue をすべて選択`} selected={selectedIds} onChange={toggleMany} /> : undefined}
                />
                {layout === "board" ? <IssueBoard rows={group.rows} nameOfStatus={nameOfStatus} /> : group.subgroups && subGroupBy ? (
                  group.subgroups.map((subgroup) => (
                    <section key={subgroup.key} className={s.subgroup} aria-label={`${GROUP_NAMES[subGroupBy]} ${subgroup.label}`}>
                      <GroupHeading by={subGroupBy} group={subgroup} level={3} delegated={delegated} />
                      {table(subgroup.rows)}
                    </section>
                  ))
                ) : table(group.rows)}
              </section>
            ))
          )
        ) : layout === "list" ? (
          table(visible)
        ) : (
          <IssueBoard rows={visible} nameOfStatus={nameOfStatus} />
        )}
        {selectedIssues.length > 0 && (
          <BulkActionBar
            selected={selectedIssues}
            labels={knownLabels}
            nameOfStatus={nameOfStatus}
            onClear={clearSelection}
            onUpdated={(count) => {
              clearSelection();
              setToast(`${count}件を更新しました`);
              // バーが消えてもキーボードの位置を失わないよう、全選択のチェックボックスへ戻す
              selectAllRef.current?.focus();
            }}
          />
        )}
        {toast && (
          <div role="status" className={s.bulkToast}>
            <Icon name="circle-check" size={14} color="var(--ready)" />
            {toast}
          </div>
        )}
      </div>
    </div>
    {preview && (
      <PreviewPane
        key={preview}
        issueId={preview}
        titles={titles}
        workspaceName={(key) => workspaceNames.get(key) ?? key}
        onClose={closePreview}
      />
    )}
    </div>
  );
}

const AGENT_STATES = Object.keys(AGENT_STATE_META) as AgentState[];
const NO_SELECTION: ReadonlySet<string> = new Set();

// 表示順の ID（ラベルのグループで同じ Issue が何度も出ても1回だけ）
function idsOf(rows: IssueListRow[]): string[] {
  return [...new Set(rows.map((r) => r.issue.id))];
}

function rowsOf(group: RowGroup): IssueListRow[] {
  return group.subgroups ? group.subgroups.flatMap((subgroup) => subgroup.rows) : group.rows;
}

// 表示中・グループの全選択のチェックボックス。一部だけ選んでいるときは不定の表示にする
function SelectAllBox({ ids, label, selected, onChange, inputRef }: { ids: string[]; label: string; selected: ReadonlySet<string>; onChange: (ids: string[]) => void; inputRef?: { current: HTMLInputElement | null } }) {
  const state = selectAllState(selected, ids);
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={s.checkbox}
      aria-label={label}
      checked={state === "all"}
      disabled={ids.length === 0}
      onChange={() => onChange(ids)}
    />
  );
}

// design/nod.pen「11 Issues」のグループ行（高さ 36、角丸 8）：アイコン、名前、件数
// サブグループの見出しは「Issues｜サブグループ」の行（高さ 32、白地）
// 委任中タブの担当の見出しは「Issues｜委任中タブ（#53）」：アバター、LLM 名、件数、作業状況の内訳（0件は出さない）
function GroupHeading({ by, group, level = 2, delegated = false, select }: { by: IssueGroupKey; group: RowGroup; level?: 2 | 3; delegated?: boolean; select?: ReactNode }) {
  const empty = group.key === "";
  const Heading = level === 2 ? "h2" : "h3";
  if (delegated && by === "assignee" && !empty) {
    const breakdown = AGENT_STATES.map((state) => [state, group.rows.filter((r) => r.issue.agentState === state).length] as const)
      .filter(([, n]) => n > 0);
    return (
      <Heading className={level === 2 ? s.groupHeading : s.subgroupHeading}>
        {select}
        <AgentAvatar actor={group.key} />
        <span className={`${s.groupLabel} ${s.agentName}`}>{group.label}</span>
        <span className={s.groupCount} aria-label={`${group.rows.length} 件`}>{group.rows.length}</span>
        {breakdown.length > 0 && (
          <span className={s.breakdown} aria-label="作業状況の内訳">
            {breakdown.map(([state, n]) => (
              <AgentStateDot key={state} state={state}>{`${AGENT_STATE_META[state].label} ${n}`}</AgentStateDot>
            ))}
          </span>
        )}
      </Heading>
    );
  }
  return (
    <Heading className={level === 2 ? s.groupHeading : s.subgroupHeading}>
      {select}
      {by === "workspace" ? (
        <WorkspaceBadge workspaceKey={group.key} name={group.workspaceName ?? group.key} />
      ) : (
        <>
          {by === "status" && <StatusIcon status={group.key as Status} />}
          {by === "priority" && <Icon name={priorityMeta(Number(group.key)).icon} size={14} color={TONE_COLORS[priorityMeta(Number(group.key)).tone].fg} />}
          {by === "project" && <Icon name={empty ? "minus" : "box"} size={14} color="var(--ink3)" />}
          {by === "cycle" && <Icon name={empty ? "circle-dashed" : "calendar-range"} size={14} color={group.current ? "var(--accent)" : "var(--ink3)"} />}
          {by === "assignee" && <Icon name={empty ? "minus" : "circle-user"} size={14} color="var(--ink3)" />}
          {by === "label" && <Icon name={empty ? "minus" : "tag"} size={14} color="var(--ink3)" />}
          <span className={s.groupLabel}>{group.label}</span>
        </>
      )}
      <span className={s.groupCount} aria-label={`${group.rows.length} 件`}>{group.rows.length}</span>
    </Heading>
  );
}
