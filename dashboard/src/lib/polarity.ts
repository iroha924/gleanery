import type { Polarity } from "./api";

/** 極性の色。「やらないと決めた」は破壊的操作の色（destructive）とは意味が違うので分ける。 */
export function polarityClass(p: Polarity): string {
  return p === "dont" ? "text-dont" : p === "do" ? "text-do" : "text-muted-foreground";
}
