import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./ui.module.css";

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  icon,
  children,
  disabled,
  title,
  className,
  onClick,
}: {
  variant?: "primary" | "secondary" | "danger" | "destructive" | "soft";
  size?: "md" | "sm"; // 高さ 28（左右 12）と 24（左右 10）
  type?: "button" | "submit";
  icon?: IconName;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  onClick?: () => void;
}) {
  const variantClass =
    variant === "primary" ? s.primary : variant === "danger" ? s.danger : variant === "destructive" ? s.destructive : variant === "soft" ? s.soft : "";
  return (
    <button type={type} className={`${s.button} ${size === "sm" ? s.buttonSm : ""} ${variantClass} ${className ?? ""}`} disabled={disabled} title={title} onClick={onClick}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// 28×28 の円形のアイコンボタン。文字がないため、label を aria-label と title にする
export function IconButton({
  icon,
  label,
  bordered,
  disabled,
  title,
  className,
  onClick,
  ...aria
}: {
  icon: IconName;
  label: string;
  bordered?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  onClick?: () => void;
  "aria-haspopup"?: "menu" | "dialog" | "listbox";
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${s.iconButton} ${bordered ? s.iconButtonBordered : ""} ${className ?? ""}`}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      {...aria}
    >
      <Icon name={icon} />
    </button>
  );
}

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  badge?: number; // 1 以上のときだけ、ラベルの後ろに数の丸を出す（Inbox の未読の通知）
}

export function Segmented<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className={s.segmented}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`${s.segment} ${active ? s.segmentActive : ""}`}
            onClick={() => onChange(item.value)}
          >
            {item.icon && <Icon name={item.icon} />}
            {item.label}
            {item.badge !== undefined && item.badge > 0 && <span className={s.segmentBadge}>{item.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
