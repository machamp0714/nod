import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCycles } from "../api/hooks/cycles";
import { useCreateView } from "../api/hooks/views";
import { Icon, IconButton, type IconName } from "../components/ui";
import { ViewDialog } from "../components/views/ViewDialog";
import { currentCycleLink } from "../lib/cycles";
import { workspaceColorOf } from "../lib/workspace-color";
import s from "./layout.module.css";
import { useSidebarData } from "./useSidebarData";

type NavPath = "/inbox" | "/reviews" | "/triage" | "/open-questions" | "/issues" | "/my-issues" | "/initiatives" | "/projects" | "/cycles" | "/documents" | "/analytics" | "/summary";

const ACTIVE_PROPS = { className: s.active, "aria-current": "page" } as const;

// exact は配下のパスで選択中にしない（今の Cycle の詳細を開いているときの「Cycles」）
function NavItem({ to, icon, label, count, askTone, exact }: { to: NavPath; icon: IconName; label: string; count?: number; askTone?: boolean; exact?: boolean }) {
  return (
    <Link to={to} className={s.item} activeProps={ACTIVE_PROPS} activeOptions={{ includeSearch: false, exact }}>
      <span className={s.itemIcon}>
        <Icon name={icon} />
      </span>
      <span className={s.label}>{label}</span>
      {count !== undefined && <span className={`${s.count} ${askTone && count > 0 ? s.countAsk : ""}`}>{count}</span>}
    </Link>
  );
}

// 「Cycles」の下に1段下げて置く「Current」。右端に今の Cycle の名前（なければ「なし」）を出す。
// 今の Cycle の詳細を開いているときだけ選択中にする。なしのときの行き先は一覧だが、一覧では「Cycles」だけを選択中にするため、
// Link の自動の選択中（aria-current）を使わず、選択中は呼び出し側が決める
function CurrentCycleItem({ to, label, active }: { to: string; label: string; active: boolean }) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      className={`${s.item} ${s.subItem} ${active ? s.active : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void navigate({ to });
      }}
    >
      <span className={s.itemIcon}>
        <Icon name="circle-dot" size={12} />
      </span>
      <span className={s.label}>Current</span>
      <span className={s.subNote}>{label}</span>
    </a>
  );
}

// spec：最初のリリースに含めない項目は、サイドバーに残して準備中と表示する。
function SoonItem({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className={`${s.item} ${s.soon}`} aria-disabled="true" title="準備中">
      <span className={s.itemIcon}>
        <Icon name={icon} />
      </span>
      <span className={s.label}>{label}</span>
      <span className={s.count}>Soon</span>
    </div>
  );
}

// Mac は ⇧⌘F、それ以外は Ctrl+Shift+F
const SEARCH_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⇧⌘F" : "Ctrl+Shift+F";

export function Sidebar({ onOpenSearch }: { onOpenSearch: () => void }) {
  const { counts, views, viewsReady, workspaces } = useSidebarData();
  const navigate = useNavigate();
  const createView = useCreateView();
  const [creating, setCreating] = useState(false);
  const current = currentCycleLink(useCycles().data);
  const { pathname } = useLocation();
  const currentActive = current !== null && current.to !== "/cycles" && pathname === current.to;
  return (
    <nav aria-label="メイン" className={s.sidebar}>
      <div className={s.top}>
        <span className={s.logo}>n</span>
        <span className={s.name}>nod</span>
        <IconButton icon="search" label="検索" title={`Issue を検索（${SEARCH_SHORTCUT}）`} onClick={onOpenSearch} />
        <IconButton icon="square-pen" label="New Issue" title="New Issue（準備中）" bordered disabled />
      </div>

      <div className={s.group}>
        <NavItem to="/inbox" icon="inbox" label="Inbox" count={counts.inbox} askTone />
        <NavItem to="/reviews" icon="git-pull-request" label="Reviews" count={counts.reviews} />
        <NavItem to="/triage" icon="list-filter" label="Triage" count={counts.triage} />
        {/* 人が付けた未回答の未決事項（#173）。件数は通常色で、0 件のときは出さない（nod.pen tj2L4） */}
        <NavItem to="/open-questions" icon="message-circle-warning" label="Open questions" count={counts.openQuestions || undefined} />
      </div>

      <div className={s.group}>
        <div className={s.heading}>All workspaces</div>
        <NavItem to="/issues" icon="copy" label="Issues" />
        <NavItem to="/initiatives" icon="target" label="Initiatives" />
        <NavItem to="/projects" icon="box" label="Projects" />
        <NavItem to="/cycles" icon="calendar-range" label="Cycles" exact={currentActive} />
        {current && <CurrentCycleItem to={current.to} label={current.label} active={currentActive} />}
        <NavItem to="/documents" icon="file-text" label="Documents" />
        <NavItem to="/analytics" icon="chart-column" label="Analytics" />
        <NavItem to="/summary" icon="activity" label="Summary" />
        <NavItem to="/my-issues" icon="circle-user" label="My issues" />
        <SoonItem icon="star" label="Favorites" />
      </div>

      {workspaces.length > 0 && (
        <div className={s.group}>
          {workspaces.map((workspace) => (
            <div key={workspace.key} className={s.workspaceHeading}>
              <span className={s.workspaceSwatch} style={{ background: workspaceColorOf(workspaces, workspace.key) }} />
              <span className={s.workspaceName}>{workspace.name}</span>
              <Link
                to="/workspaces/$workspaceKey/settings"
                params={{ workspaceKey: workspace.key }}
                className={s.settingsLink}
                activeProps={ACTIVE_PROPS}
                title="設定"
                aria-label={`${workspace.name} の設定`}
              >
                <Icon name="settings" />
              </Link>
            </div>
          ))}
        </div>
      )}

      <div className={s.group}>
        <div className={s.heading}>
          <span>Views</span>
          <button type="button" className={s.headingButton} title="View を作成" aria-label="View を追加" disabled={!viewsReady} onClick={() => setCreating(true)}>
            <Icon name="plus" />
          </button>
        </div>
        {views.map((view) => (
          <Link
            key={view.id}
            to="/views/$viewId"
            params={{ viewId: String(view.id) }}
            className={s.item}
            activeProps={ACTIVE_PROPS}
            activeOptions={{ includeSearch: false }}
          >
            <span className={s.swatchBox}>
              <span className={s.swatch} style={{ background: view.color ?? undefined }} />
            </span>
            <span className={s.label}>{view.name}</span>
          </Link>
        ))}
      </div>
      {creating && (
        <ViewDialog
          title="View を作成"
          submitLabel="作成"
          initial={{ name: "", color: null }}
          views={viewsReady ? views : undefined}
          selfId={null}
          onSubmit={async (value) => {
            const view = await createView.mutateAsync({ ...value, filter: {} });
            setCreating(false);
            navigate({ to: "/views/$viewId", params: { viewId: String(view.id) } });
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </nav>
  );
}
