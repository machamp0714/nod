import type { ComponentPropsWithRef } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./ui.module.css";

// <button> の残りの props（ref、onKeyDown、aria-haspopup、aria-expanded、aria-controls など）はそのまま渡す。
// メニューのトリガーは、閉じたあとにフォーカスを戻すために ref を使う
export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  icon,
  children,
  className,
  ...rest
}: Omit<ComponentPropsWithRef<"button">, "type"> & {
  variant?: "primary" | "secondary" | "danger" | "destructive" | "soft";
  size?: "md" | "sm"; // 高さ 28（左右 12）と 24（左右 10）
  type?: "button" | "submit";
  icon?: IconName;
}) {
  const variantClass =
    variant === "primary" ? s.primary : variant === "danger" ? s.danger : variant === "destructive" ? s.destructive : variant === "soft" ? s.soft : "";
  return (
    <button type={type} className={`${s.button} ${size === "sm" ? s.buttonSm : ""} ${variantClass} ${className ?? ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// 28×28 の円形のアイコンボタン。文字がないため、label を aria-label と title にする。残りの props は Button と同じく渡す
export function IconButton({
  icon,
  label,
  bordered,
  title,
  className,
  ...rest
}: Omit<ComponentPropsWithRef<"button">, "type" | "children" | "aria-label"> & {
  icon: IconName;
  label: string;
  bordered?: boolean;
}) {
  return (
    <button type="button" className={`${s.iconButton} ${bordered ? s.iconButtonBordered : ""} ${className ?? ""}`} aria-label={label} title={title ?? label} {...rest}>
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
