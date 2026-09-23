// marked-terminal は型を同梱しない。@types/marked-terminal は依存に marked <12 を引き込むので入れず、使う分だけ宣言する。
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export function markedTerminal(
    options?: { width?: number; reflowText?: boolean; tab?: number; [key: string]: unknown },
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
