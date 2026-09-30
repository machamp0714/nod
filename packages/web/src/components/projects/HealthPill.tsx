import { useEffect, useId, useRef, useState } from "react";
import type { ProjectHealth } from "../../api/types";
import { Icon, type IconName } from "../ui";
import s from "./health.module.css";

// Pencil「健全性 Pill」（yo7H6）。LLM の状況の Pill とは別の専用書式（白地・色枠・状態アイコン）
const HEALTH: Record<ProjectHealth, { label: string; icon: IconName; className: string | undefined }> = {
  on_track: { label: "On track", icon: "circle-check", className: s.onTrack },
  at_risk: { label: "At risk", icon: "triangle-alert", className: s.atRisk },
  off_track: { label: "Off track", icon: "circle-x", className: s.offTrack },
};
const UNSET = { label: "未設定", icon: "circle-dashed" as IconName, className: s.unset };

export const HEALTH_OPTIONS: ProjectHealth[] = ["on_track", "at_risk", "off_track"];

export function healthLabel(health: ProjectHealth | null): string {
  return (health && HEALTH[health]?.label) || "未設定";
}

export function HealthPill({ health }: { health: ProjectHealth | null }) {
  const meta = (health && HEALTH[health]) || UNSET;
  return (
    <span className={`${s.pill} ${meta.className}`} data-health={health ?? "unset"}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </span>
  );
}

// 進捗報告に添える健全性の選択（djnRu と nSTRL のメニュー）。null は「未指定」で、現在の健全性を変えない
export function HealthSelect({
  value,
  onChange,
  disabled,
}: {
  value: ProjectHealth | null;
  onChange: (value: ProjectHealth | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const choose = (next: ProjectHealth | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className={s.selectRoot} ref={root}>
      <button
        type="button"
        className={s.select}
        aria-label={`健全性: ${value ? healthLabel(value) : "未指定"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className={s.selectLabel}>健全性</span>
        {value ? <HealthPill health={value} /> : <span className={s.unspecified}>未指定</span>}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label="健全性" className={s.menu} onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
          {[null, ...HEALTH_OPTIONS].map((option) => (
            <li key={option ?? "none"} role="option" aria-selected={option === value}>
              <button type="button" className={`${s.option} ${option === value ? s.optionActive : ""}`} onClick={() => choose(option)}>
                {option ? <HealthPill health={option} /> : <span className={s.unspecified}>未指定</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
