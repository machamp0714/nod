import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Icon, Menu, MenuItem } from "../ui";
import s from "./issue-detail.module.css";

export interface PropertyOption {
  value: string; // "" は未設定。ピルの文字を薄くする
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

// nod.pen「コントロールの型」（PR46C）のピル型ボタンと「Property Menu」（J0qDy）。
// ピルを押すと直下にメニューが開く。検索欄で絞り込み、上下キーで項目を移り、Escape で閉じてピルへ戻る。
// label はピルのアクセシビリティ名。今の値は data-value に出す
export function PropertyMenu({ label, value, options, disabled = false, describedBy, onChange }: {
  label: string;
  value: string;
  options: PropertyOption[];
  disabled?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const current = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const shown = options.filter((option) => option.label.toLowerCase().includes(needle));

  function close(focus: boolean) {
    setOpen(false);
    setQuery("");
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // 保存中はピルが disabled になりフォーカスを失うため、終わったらピルへ戻す
  useEffect(() => {
    if (disabled || !refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body) trigger.current?.focus();
  }, [disabled]);

  function choose(option: PropertyOption) {
    if (option.disabled) return;
    close(true);
    if (option.value === value) return;
    refocus.current = true;
    onChange(option.value);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    if (event.key === "Tab") { close(false); return; }
    const inSearch = event.target === search.current;
    if (inSearch && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const first = shown.find((option) => !option.disabled);
      if (first) choose(first);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // 検索欄の Home と End は文字の移動に使う
    if (inSearch && (event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const down = event.key === "ArrowDown";
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : at === -1 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <span className={s.propMenuRoot} ref={root}>
      <button
        type="button"
        ref={trigger}
        className={s.propButton}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-describedby={describedBy}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {current?.icon}
        <span className={value === "" ? `${s.propText} ${s.propPlaceholder}` : s.propText}>{current?.label ?? value}</span>
      </button>
      {open && (
        <div className={s.propPopover} onKeyDown={onKeyDown}>
          <input
            ref={search}
            className={s.propSearch}
            aria-label={`${label} を検索`}
            placeholder={`${label} を変更…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className={s.propMenuEmpty}>該当する項目はありません</p>
          ) : (
            <Menu label={`${label} を変更`} className={s.propOptions}>
              {shown.map((option) => (
                <MenuItem key={option.value} checked={option.value === value} disabled={option.disabled} className={s.propOption} onClick={() => choose(option)}>
                  {option.icon}
                  <span className={s.propText}>{option.label}</span>
                  {option.value === value && <span className={s.propCheck}><Icon name="check" /></span>}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      )}
    </span>
  );
}
