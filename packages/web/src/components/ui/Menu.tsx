import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import s from "./ui.module.css";

// メニューの枠（角丸 12）。位置は呼び出し側の className で決める
export function Menu({ label, className, onKeyDown, children }: { label: string; className?: string; onKeyDown?: KeyboardEventHandler<HTMLDivElement>; children: ReactNode }) {
  return (
    <div role="menu" aria-label={label} className={`${s.menu} ${className ?? ""}`} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

// メニューの項目（高さ 32、角丸 8）。checked を渡すと、選択中を示す menuitemradio にする
export function MenuItem({ checked, disabled, className, onClick, ref, children }: { checked?: boolean; disabled?: boolean; className?: string; onClick?: () => void; ref?: Ref<HTMLButtonElement>; children: ReactNode }) {
  return (
    <button
      ref={ref}
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={`${s.menuItem} ${className ?? ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
