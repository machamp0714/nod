import type { ActivityItem } from "../../api/types";
import { describeActivity, visibleActivity } from "../../lib/activity";
import { formatRelative } from "../../lib/format";
import { isStatus } from "../../lib/meta";
import { statusName } from "../../lib/workspace-labels";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { Icon } from "./Icon";
import s from "./ui.module.css";

// workspace を渡すと、ステータスの変更をその Workspace の表示名で書く
export function ActivityLines({ items, workspace }: { items: ActivityItem[]; workspace?: string }) {
  const names = useStatusNames();
  return (
    <ul className={s.activity}>
      {visibleActivity(items).map((item, index) => {
        const line = describeActivity(item, (value) => (isStatus(value) ? statusName(value, names.data, workspace) : String(value)));
        return (
          <li key={`${item.at}-${index}`} className={s.activityLine}>
            <span className={s.activityIcon}>
              <Icon name={line.icon} />
            </span>
            <span className={s.activityText}>{line.text}</span>
            <span className={s.activityTime}>{formatRelative(item.at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
