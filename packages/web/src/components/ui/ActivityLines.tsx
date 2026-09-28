import type { ActivityItem } from "../../api/types";
import { describeActivity, visibleActivity } from "../../lib/activity";
import { formatRelative } from "../../lib/format";
import { Icon } from "./Icon";
import s from "./ui.module.css";

export function ActivityLines({ items }: { items: ActivityItem[] }) {
  return (
    <ul className={s.activity}>
      {visibleActivity(items).map((item, index) => {
        const line = describeActivity(item);
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
