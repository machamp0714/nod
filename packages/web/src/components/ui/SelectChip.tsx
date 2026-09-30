import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./Icon";
import s from "./ui.module.css";

// View Bar の中のフィルタの並び（nod.pen の Filter Bar）。幅が足りなければ折り返す
export function FilterRow({ children }: { children: ReactNode }) {
  return <div className={s.filterRow}>{children}</div>;
}

// ラベルつきの選択。見た目は nod.pen の Select（枠・ラベル・値・下向き矢印）で、操作はネイティブの select に任せる。
// 幅は今の値で決まり、長い名前は切れるので、選択中の選択肢の全文を title で読めるようにする
export function SelectChip({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const chip = useRef<HTMLLabelElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  // 選択肢は children で渡り、あとから届くこともあるため、描画のたびに選択中の文言を読む
  useEffect(() => {
    if (chip.current) chip.current.title = select.current?.selectedOptions[0]?.text ?? "";
  });
  return (
    <label ref={chip} className={s.selectChip}>
      <span className={s.selectChipLabel}>{label}</span>
      <select ref={select} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} color="var(--ink3)" />
    </label>
  );
}
