import { createFileRoute, retainSearchParams, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { SessionsPage } from "@/features/_sessions/ui/sessions-page";

/** URL から消す既定値。ここに無い値は URL に残る。 */
const DEFAULTS = { mode: "knowledge", page: 1 } as const;

// URL が正本。壊れた値でも 404 にせず既定へ倒して一覧を出す。
// mode の綴りは searchSessions の引数型と突き合わされるので、増減すれば型検査で落ちる。
const searchSchema = z.object({
  /** 開いているセッションの id。閉じると消える */
  session: z.string().optional().catch(undefined),
  /** 検索語。空文字は「検索していない」と同じ */
  q: z.string().min(1).optional().catch(undefined),
  mode: z.enum(["knowledge", "avoid", "said"]).default(DEFAULTS.mode).catch(DEFAULTS.mode),
  page: z.number().int().positive().default(DEFAULTS.page).catch(DEFAULTS.page),
});

export const Route = createFileRoute("/sessions")({
  validateSearch: searchSchema,
  // **strip が先。**retain を先に置くと、剥がした既定値を retain が書き戻す（実測）。
  // retain は /sessions に閉じる。root に置くと q や page がチャットと会議へ漏れる。
  search: { middlewares: [stripSearchParams(DEFAULTS), retainSearchParams(["q", "mode", "page"])] },
  component: SessionsPage,
});
