import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateView } from "../api/hooks/views";
import { Icon, type IconName } from "../components/ui";
import { ViewDialog } from "../components/views/ViewDialog";
import { workspaceColorOf } from "../lib/workspace-color";
import s from "./layout.module.css";
import { useSidebarData } from "./useSidebarData";

type NavPath = "/inbox" | "/reviews" | "/triage" | "/issues" | "/my-issues" | "/initiatives" | "/projects" | "/cycles" | "/documents" | "/analytics" | "/summary";

const ACTIVE_PROPS = { className: s.active, "aria-current": "page" } as const;

function NavItem({ to, icon, label, count, askTone }: { to: NavPath; icon: IconName; label: string; count?: number; askTone?: boolean }) {
  return (
    <Link to={to} className={s.item} activeProps={ACTIVE_PROPS} activeOptions={{ includeSearch: false }}>
      <span className={s.itemIcon}>
        <Icon name={icon} size={16} />
      </span>
      <span className={s.label}>{label}</span>
      {count !== undefined && <span className={`${s.count} ${askTone && count > 0 ? s.countAsk : ""}`}>{count}</span>}
    </Link>
  );
}

// spec：最初のリリースに含めない項目は、サイドバーに残して準備中と表示する。
function SoonItem({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className={`${s.item} ${s.soon}`} aria-disabled="true" title="準備中">
      <span className={s.itemIcon}>
        <Icon name={icon} size={16} />
      </span>
      <span className={s.label}>{label}</span>
      <span className={s.count}>Soon</span>
    </div>
  );
}

export function Sidebar() {
  const { counts, views, viewsReady, workspaces } = useSidebarData();
  const navigate = useNavigate();
  const createView = useCreateView();
  const [creating, setCreating] = useState(false);
  return (
    <nav aria-label="メイン" className={s.sidebar}>
      <div className={s.top}>
        <span className={s.logo}>n</span>
        <span className={s.name}>nod</span>
        <button type="button" className={s.iconButton} disabled title="検索（準備中）" aria-label="検索">
          <Icon name="search" size={15} />
        </button>
        <button type="button" className={`${s.iconButton} ${s.bordered}`} disabled title="New Issue（準備中）" aria-label="New Issue">
          <Icon name="square-pen" size={15} />
        </button>
      </div>

      <div className={s.group}>
        <NavItem to="/inbox" icon="inbox" label="Inbox" count={counts.inbox} askTone />
        <NavItem to="/reviews" icon="git-pull-request" label="Reviews" count={counts.reviews} />
        <NavItem to="/triage" icon="list-filter" label="Triage" count={counts.triage} />
      </div>

      <div className={s.group}>
        <div className={s.heading}>All workspaces</div>
        <NavItem to="/issues" icon="copy" label="Issues" />
        <NavItem to="/initiatives" icon="target" label="Initiatives" />
        <NavItem to="/projects" icon="box" label="Projects" />
        <NavItem to="/cycles" icon="calendar-range" label="Cycles" />
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
