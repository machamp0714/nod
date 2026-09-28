import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./ui.module.css";

export function Button({
  variant = "secondary",
  type = "button",
  icon,
  children,
  disabled,
  title,
  onClick,
}: {
  variant?: "primary" | "secondary" | "danger" | "soft";
  type?: "button" | "submit";
  icon?: IconName;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const variantClass =
    variant === "primary" ? s.primary : variant === "danger" ? s.danger : variant === "soft" ? s.soft : "";
  return (
    <button type={type} className={`${s.button} ${variantClass}`} disabled={disabled} title={title} onClick={onClick}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
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
          </button>
        );
      })}
    </div>
  );
}
