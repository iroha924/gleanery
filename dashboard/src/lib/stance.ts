import type { Stance } from "./api";

/** 札の色。「やらないと決めた」は破壊的操作の色（destructive）とは意味が違うので分ける。 */
export function stanceClass(s: Stance): string {
  return s === "dont" ? "text-dont" : s === "do" ? "text-do" : "text-muted-foreground";
}
