// Replaces the colors of @inkjs/ui parts (Alert, StatusMessage, ProgressBar, Spinner, Badge) with the earth tones in palette.ts.
// extendTheme replaces whole functions, so the non-color styles (borders, padding) copy the default values.

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
    // Badge backgrounds are muted mid tones, so black text stays readable
    Badge: { styles: { label: () => ({ color: "black" }) } },
  },
});
