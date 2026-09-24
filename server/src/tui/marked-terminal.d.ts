// marked-terminal ships no types. @types/marked-terminal pulls in marked <12, so only what is used is declared here.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export function markedTerminal(
    options?: { width?: number; reflowText?: boolean; tab?: number; [key: string]: unknown },
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
