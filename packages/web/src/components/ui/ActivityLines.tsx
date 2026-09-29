import type { ActivityItem } from "../../api/types";
import { attachmentSourcePath, describeActivity, visibleActivity } from "../../lib/activity";
import { formatRelative } from "../../lib/format";
import { isStatus } from "../../lib/meta";
import { statusName } from "../../lib/workspace-labels";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { Icon } from "./Icon";
import s from "./ui.module.css";

// workspace を渡すと、ステータスの変更をその Workspace の表示名で書く。
// showSource は添付ファイルの元の場所を出すか（Issue 詳細の Activity だけで使う）
export function ActivityLines({ items, workspace, showSource = false }: { items: ActivityItem[]; workspace?: string; showSource?: boolean }) {
  const names = useStatusNames();
  return (
    <ul className={s.activity}>
      {visibleActivity(items).map((item, index) => {
        const line = describeActivity(item, (value) => (isStatus(value) ? statusName(value, names.data, workspace) : String(value)));
        const source = showSource ? attachmentSourcePath(item) : null;
        return (
          <li key={`${item.at}-${index}`} className={s.activityLine}>
            <span className={s.activityIcon}>
              <Icon name={line.icon} />
            </span>
            <span className={s.activityText}>
              {line.text}
              {source && <span className={s.activitySource}>元: {source}</span>}
            </span>
            <span className={s.activityTime}>{formatRelative(item.at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
