// @inkjs/ui の部品（Alert・StatusMessage・ProgressBar・Spinner・Badge）の色を palette.ts のアースカラーへ差し替える。
// extendTheme は関数を丸ごと置き換えるので、色以外の形（枠・余白）も既定と同じ値を書き写している。

import { defaultTheme, extendTheme } from "@inkjs/ui";
import { PALETTE } from "../palette.ts";

type Variant = "info" | "success" | "error" | "warning";
const BY_VARIANT: Record<Variant, string> = {
  info: PALETTE.slate,
  success: PALETTE.sage,
  error: PALETTE.failure,
  warning: PALETTE.ochre,
};

export const earth = extendTheme(defaultTheme, {
  components: {
    Alert: {
      styles: {
        container: ({ variant }: { variant: Variant }) => ({
          flexGrow: 1,
          borderStyle: "round",
          borderColor: BY_VARIANT[variant],
          gap: 1,
          paddingX: 1,
        }),
        icon: ({ variant }: { variant: Variant }) => ({ color: BY_VARIANT[variant] }),
      },
    },
    StatusMessage: {
      styles: { icon: ({ variant }: { variant: Variant }) => ({ color: BY_VARIANT[variant] }) },
    },
    ProgressBar: { styles: { completed: () => ({ color: PALETTE.terracotta }) } },
    Spinner: { styles: { frame: () => ({ color: PALETTE.terracotta }) } },
    // 札の地の色はくすんだ中間色なので、文字は黒で読める
    Badge: { styles: { label: () => ({ color: "black" }) } },
  },
});
