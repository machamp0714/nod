import type { View } from "../api/types";

export const VIEWS: View[] = [
  { id: 1, name: "仕事", color: "#7C5CFF", filter: { workspace: ["API"] }, position: 0 },
  { id: 2, name: "プライベート", color: "#DB2777", filter: { workspace: ["BLOG"] }, position: 1 },
];

export function findView(id: number): View | undefined {
  return VIEWS.find((v) => v.id === id);
}
