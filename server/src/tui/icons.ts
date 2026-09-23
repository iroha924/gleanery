// 端末の画面と CLI が使う記号。画面のコードは名前で参照し、記号をここ以外に書かない。
// **Unicode の標準の記号だけを使う**（持ち主の決定、2026-09-23: Nerd Font を必須にしない）。私用領域の記号は、そのフォントが
// 無い端末で □ になる。標準の記号なら、端末のフォントに無くても OS の代替フォントが描く。東アジアの文字幅が中立（1 桁）の
// 記号から選ぶ（曖昧の記号は日本語の端末の設定で 2 桁になり、列がずれる。test/tui.test.ts が見る）。

export const ICONS = {
  /** CLI の出力と画面の見出し */
  brand: "✦",
  /** セッション（会話）の一覧のタブ */
  sessions: "❝",
  /** trace した作業のタブ */
  work: "✎",
  /** 検索のタブ */
  search: "⌕",
  /** 持ち主の発言（選んでいる行の印 ❯ と紛れないよう、別の記号にする） */
  self: "✐",
  /** AI の応答 */
  assistant: "✻",
  /** 持ち主以外の人の発言 */
  person: "❖",
  /** bot の発言 */
  bot: "⌬",
  /** 触ったファイル */
  file: "❐",
  /** branch */
  branch: "⎇",
  /** プロジェクト */
  project: "⌂",
  /** trace した判断 */
  decision: "✧",
  /** 通ってはいけない道 */
  avoid: "✕",
  /** まだ答えの無い問い */
  question: "?",
  /** 目的 */
  goal: "✪",
  /** 次の手 */
  next: "➜",
  /** 状態: 進行中 */
  active: "➤",
  /** 状態: 止まっている */
  blocked: "✕",
  /** 状態: 保留 */
  paused: "❙",
  /** 状態: 終わった */
  done: "✓",
  /** 状態: やめた */
  abandoned: "✗",
  /** 失敗の表示 */
  error: "✘",
  /** PR・issue へのリンク */
  link: "➚",
} as const;

export type IconName = keyof typeof ICONS;

/**
 * 読み込み中の回転。形の近い星を順に描き替え、端まで行ったら折り返す（Claude Code の回転と同じ見せ方）。
 * `·` と `✽` は文字幅が曖昧で 2 桁になる端末があるので、描く側は幅 2 の枠に入れる。
 */
export const TWINKLE = ["·", "✢", "✳", "✶", "✻", "✽"] as const;

/** 作業の状態の記号。知らない状態は目的の記号で出す（DB の CHECK が値を縛るので、ここへは来ない想定）。 */
export function statusIcon(status: string): string {
  return status in ICONS ? ICONS[status as IconName] : ICONS.goal;
}
