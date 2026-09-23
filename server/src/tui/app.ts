// TUI の画面。セッション一覧・セッション詳細・作業・検索（計画 7 章）。**読むだけ**で、書き込みを起動する経路を持たない。
// JSX を使わず createElement で書く。この repository は Node の型剥がしで src を直接動かし、Node は JSX を読めない。

import { stripVTControlCharacters } from "node:util";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useAnimation, useApp, useInput, useWindowSize } from "ink";
import Link from "ink-link";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { createElement as h, type ReactNode, useEffect, useRef, useState } from "react";
import { kindColor, PALETTE } from "../palette.ts";
import { width } from "../panel.ts";
import type { Hit } from "../search.ts";
import type { SessionDetail, SessionRow } from "../sessions.ts";
import { ftsQuery, reason } from "../text.ts";
import type { Data, Mode } from "./data.ts";
import { ICONS, statusIcon, TWINKLE } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";

const TABS = [
  { key: "sessions", label: "セッション", icon: ICONS.sessions },
  { key: "work", label: "作業", icon: ICONS.work },
  { key: "search", label: "検索", icon: ICONS.search },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** 一覧の上に開いている詳細。Esc で一覧へ戻る。 */
type Detail = { kind: "session"; id: string } | { kind: "work"; ref: string } | { kind: "read"; ref: string };

/** 画面の上（タブ）と下（操作の案内）が使う行数。本文の高さはこれを引いて決める。 */
const CHROME = 4;

/**
 * 操作の案内を幅に収まる lines 行までに詰める。キーと説明の組は途中で割らない。入らない組は後ろから落とす
 * （大事なキーを前に並べてある）。幅は panel.ts の width で数える（記号を広めに数えるので、はみ出さない向きに外れる）。
 */
export function helpLines(items: string[], columns: number, lines = 2): string[] {
  const out: string[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last !== undefined && width(`${last}  ${item}`) <= columns) out[out.length - 1] = `${last}  ${item}`;
    else if (out.length < lines && width(item) <= columns) out.push(item);
    else break;
  }
  return out;
}
const PAGE = 50;

const when = (d: Date | null) => (d ? new Date(d).toLocaleString("sv-SE").slice(0, 16) : "—");

/** 会話を記録したホスト。一覧と詳細で同じ語にする */
const hostName = (origin: string) =>
  origin === "codex" ? "Codex" : origin === "claude-code" ? "Claude Code" : origin;

const STATUS: Record<string, string> = {
  active: "進行中",
  blocked: "止まっている",
  paused: "保留",
  done: "終わった",
  abandoned: "やめた",
};
const statusName = (status: string) => STATUS[status] ?? status;
/** 作業の状態の色。ローズウッドは「避ける判断」と「読めなかった」に取ってあるので、止まっている作業は黄土にする */
const statusColor = (status: string) =>
  status === "blocked" ? PALETTE.ochre : status === "active" ? PALETTE.sage : undefined;

type Load<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; value: T };

/** 読み込み・失敗・成功を 1 つの値で持つ。deps が変わったら読み直し、古い応答は捨てる。 */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(
    () => {
      let live = true;
      setState({ status: "loading" });
      load().then(
        (value) => live && setState({ status: "ok", value }),
        (e: unknown) => live && setState({ status: "error", error: reason(e) }),
      );
      return () => {
        live = false;
      };
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: 読み直す条件は呼び出し側が deps で決める
    deps,
  );
  return state;
}

/** 読み込み中の回転（icons.ts の TWINKLE を行って戻る）。記号は幅 2 の枠に入れ、横の文字がずれないようにする */
function Twinkle({ label }: { label: string }) {
  const { frame } = useAnimation({ interval: 120 });
  const n = TWINKLE.length;
  const at = frame % (2 * n - 2);
  const glyph = TWINKLE[at < n ? at : 2 * n - 2 - at] ?? TWINKLE[0];
  return h(
    Box,
    null,
    h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: PALETTE.terracotta }, glyph)),
    h(Text, { color: PALETTE.terracotta }, label),
  );
}

/** 読み込み中と失敗の表示。失敗は「何ができなかったか」から始める。 */
function Pending<T>({ load, what, render }: { load: Load<T>; what: string; render: (v: T) => ReactNode }) {
  if (load.status === "loading") return h(Twinkle, { label: `${what}を読んでいる…` });
  if (load.status === "error")
    return h(Text, { color: PALETTE.failure }, `${ICONS.error} ${what}を読めなかった: ${load.error}`);
  return h(Box, { flexDirection: "column", flexGrow: 1 }, render(load.value));
}

/** 選んでいる行が見える範囲だけを描く一覧。行は 1 行ずつで、選んだ行を反転する。 */
function List<T>(props: {
  items: T[];
  selected: number;
  height: number;
  empty: string;
  row: (item: T, on: boolean) => ReactNode;
}) {
  if (props.items.length === 0) return h(Text, { dimColor: true }, props.empty);
  const height = Math.max(1, props.height);
  const top = Math.min(
    Math.max(0, props.selected - Math.floor(height / 2)),
    Math.max(0, props.items.length - height),
  );
  return h(
    Box,
    { flexDirection: "column" },
    props.items
      .slice(top, top + height)
      .map((item, i) =>
        h(
          Box,
          { key: top + i, width: "100%" },
          h(
            Box,
            { flexShrink: 0, width: 2 },
            h(
              Text,
              { color: top + i === props.selected ? PALETTE.terracotta : undefined },
              top + i === props.selected ? "❯" : " ",
            ),
          ),
          props.row(item, top + i === props.selected),
        ),
      ),
  );
}

/** ↑↓ / j k で動かす選択。PageUp / PageDown は画面の高さずつ。 */
function useSelection(count: number, height: number, active: boolean): [number, (n: number) => void] {
  const [selected, setSelected] = useState(0);
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n));
  useEffect(() => {
    if (selected >= count) setSelected(Math.max(0, count - 1));
  }, [count, selected]);
  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") setSelected((s) => clamp(s + 1));
      else if (key.upArrow || input === "k") setSelected((s) => clamp(s - 1));
      else if (key.pageDown) setSelected((s) => clamp(s + height));
      else if (key.pageUp) setSelected((s) => clamp(s - height));
      else if (key.home || input === "g") setSelected(0);
      else if (key.end || input === "G") setSelected(clamp(count - 1));
    },
    { isActive: active },
  );
  return [selected, setSelected];
}

/** 長い本文。↑↓ / j k で 1 行、PageUp / PageDown で 1 画面ずつ動かす。 */
function Scroll({ height, active, children }: { height: number; active: boolean; children?: ReactNode }) {
  const ref = useRef<ScrollViewRef>(null);
  useInput(
    (input, key) => {
      const s = ref.current;
      if (!s) return;
      // scrollBy は本文の終わりで止まらず、画面が空になる。終わり（getBottomOffset）までに収めて動かす
      const by = (delta: number) =>
        s.scrollTo(Math.max(0, Math.min(s.getBottomOffset(), s.getScrollOffset() + delta)));
      if (key.downArrow || input === "j") by(1);
      else if (key.upArrow || input === "k") by(-1);
      else if (key.pageDown || input === " ") by(Math.max(1, height - 1));
      else if (key.pageUp) by(-Math.max(1, height - 1));
      else if (key.home || input === "g") s.scrollToTop();
      else if (key.end || input === "G") s.scrollToBottom();
    },
    { isActive: active },
  );
  return h(Box, { height, flexDirection: "column" }, h(ScrollView, { ref }, children));
}

function SessionList(p: {
  data: Data;
  project: number | null;
  height: number;
  width: number;
  active: boolean;
  open: (d: Detail) => void;
}) {
  const [page, setPage] = useState(1);
  const load = useLoad(() => p.data.sessions(p.project, page, PAGE), [p.project, page]);
  const items = load.status === "ok" ? load.value.items : [];
  const pages = load.status === "ok" ? load.value.pages : 1;
  const [selected, setSelected] = useSelection(items.length, p.height - 1, p.active);
  useInput(
    (input, key) => {
      const row = items[selected];
      if (key.return && row) p.open({ kind: "session", id: row.id });
      else if ((key.rightArrow || input === "l") && page < pages) {
        setPage(page + 1);
        setSelected(0);
      } else if ((key.leftArrow || input === "h") && page > 1) {
        setPage(page - 1);
        setSelected(0);
      }
    },
    { isActive: p.active },
  );
  return h(Pending<{ items: SessionRow[]; total: number }>, {
    load,
    what: "セッションの一覧",
    render: (v) => [
      h(
        Text,
        { key: "head", dimColor: true },
        `${v.total} 件${pages > 1 ? `（${page} / ${pages} ページ、← → でめくる）` : ""}`,
      ),
      h(List<SessionRow>, {
        key: "list",
        items: v.items,
        selected,
        height: p.height - 1,
        empty: "このプロジェクトには自動記録したセッションがまだ無い。",
        row: (s, on) =>
          h(
            Box,
            { flexGrow: 1 },
            h(
              Box,
              { flexGrow: 1, flexShrink: 1, minWidth: 8 },
              h(Text, { wrap: "truncate-end", bold: on }, oneLine(s.title)),
            ),
            // 右の列は縮めず、題だけを切る（縮めると長い題の行で日時と件数が先に消え、行ごとに列もずれる）。
            // 狭い端末では出す項目を減らす
            h(
              Box,
              { flexShrink: 0 },
              h(
                Text,
                { dimColor: true },
                p.width >= 100
                  ? `  ${hostName(s.origin).padEnd(11)}  ${when(s.lastAt ?? s.startedAt)}  ${ICONS.self} ${String(s.said).padStart(3)}  ${ICONS.file} ${String(s.files).padStart(3)}  ${ICONS.decision} ${String(s.traced).padStart(2)}`
                  : p.width >= 70
                    ? `  ${when(s.lastAt ?? s.startedAt)}  ${ICONS.self} ${String(s.said).padStart(3)}`
                    : `  ${when(s.lastAt ?? s.startedAt).slice(5)}`,
              ),
            ),
          ),
      }),
    ],
  });
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** marked-terminal（cli-table3）が描く表の行。罫線で始まる行か、│ で始まって │ で終わる行だけ。地の文の │ は当てない */
const TABLE_LINE = /^\s*(?:[┌├└]|│.*│\s*$)/u;

const speakerIcon: Record<string, string> = {
  self: ICONS.self,
  assistant: ICONS.assistant,
  person: ICONS.person,
  bot: ICONS.bot,
};
const speakerName: Record<string, string> = { self: "持ち主", assistant: "AI", person: "人", bot: "bot" };

function SessionView(p: { data: Data; id: string; height: number; width: number; active: boolean }) {
  const load = useLoad(() => p.data.session(p.id), [p.id]);
  return h(Pending<SessionDetail | null>, {
    load,
    what: "セッション",
    render: (s) =>
      s === null
        ? h(Text, { dimColor: true }, "このセッションは無い（消されたか、GitHub の会話）。")
        : h(Scroll, { height: p.height, active: p.active }, ...sessionBody(s, p.width)),
  });
}

function sessionBody(s: SessionDetail, width: number): ReactNode[] {
  const body = width - 4;
  const out: ReactNode[] = [
    h(
      Box,
      { key: "head", flexDirection: "column", marginBottom: 1 },
      h(Text, { bold: true }, oneLine(s.title)),
      h(
        Text,
        { dimColor: true },
        `${ICONS.project} ${s.project}  ${s.branch ? `${ICONS.branch} ${s.branch}  ` : ""}${when(s.startedAt)}  ${hostName(s.origin)}`,
      ),
    ),
  ];
  for (const m of s.messages) {
    const files = m.files.map(
      (f) => `${f.action === "edit" ? "編集" : f.action === "read" ? "読んだ" : "レビュー"} ${f.path}`,
    );
    out.push(
      h(
        Box,
        { key: m.id, flexDirection: "column", marginBottom: 1 },
        h(
          Text,
          {
            color:
              m.speaker === "self" ? PALETTE.slate : m.speaker === "assistant" ? PALETTE.plum : PALETTE.sand,
            bold: true,
          },
          `${speakerIcon[m.speaker] ?? ICONS.person} ${speakerName[m.speaker] ?? m.speaker}`,
          h(
            Text,
            { dimColor: true, bold: false },
            `  ${when(m.sentAt)}${m.truncated ? `  （${m.originalBytes} bytes から切った）` : ""}`,
          ),
        ),
        h(
          Box,
          { paddingLeft: 2, flexDirection: "column" },
          ...(m.speaker === "assistant"
            ? renderMarkdown(m.body, body)
                .split("\n")
                .map((line, i) =>
                  // 表の罫線の行は折り返すと崩れるので切る。本文は Ink が端末の幅で折り返す
                  h(
                    Text,
                    // 表の行の頭には色の制御文字が付くので、外してから見る
                    {
                      key: i,
                      wrap: TABLE_LINE.test(stripVTControlCharacters(line)) ? "truncate-end" : "wrap",
                    },
                    line || " ",
                  ),
                )
            : [h(Text, { key: "b" }, m.body)]),
        ),
        files.length > 0 ? h(Text, { dimColor: true }, `  ${ICONS.file} ${files.join(" / ")}`) : null,
      ),
    );
  }
  if (s.knowledge.length > 0)
    out.push(
      h(
        Box,
        { key: "knowledge", flexDirection: "column", marginBottom: 1 },
        h(Text, { bold: true }, `${ICONS.decision} このセッションで trace した記録`),
        ...s.knowledge.map((k) =>
          h(
            Text,
            { key: k.id, color: kindColor(k.kind, k.status) },
            `  ${k.label} ${oneLine(k.body)}${k.reason ? `（${oneLine(k.reason)}）` : ""}`,
          ),
        ),
      ),
    );
  for (const w of s.work)
    out.push(
      h(
        Text,
        { key: w.ref },
        `${statusIcon(w.status)} 作業: ${w.title}（${statusName(w.status)}） いま: ${oneLine(w.current)}`,
      ),
    );
  return out;
}

function WorkList(p: {
  data: Data;
  project: number | null;
  height: number;
  active: boolean;
  open: (d: Detail) => void;
}) {
  const load = useLoad(() => p.data.works(p.project), [p.project]);
  const items = load.status === "ok" ? load.value : [];
  const [selected] = useSelection(items.length, p.height, p.active);
  useInput(
    (_input, key) => {
      const w = items[selected];
      if (key.return && w) p.open({ kind: "work", ref: w.ref });
    },
    { isActive: p.active },
  );
  return h(Pending<typeof items>, {
    load,
    what: "作業の一覧",
    render: (works) =>
      h(List<(typeof items)[number]>, {
        items: works,
        selected,
        height: p.height,
        empty: "trace した作業はまだ無い。作業の現在地は trace で残す（/gleanery:trace）。",
        row: (w, on) =>
          h(
            Box,
            { flexGrow: 1 },
            h(Box, { flexShrink: 0 }, h(Text, { color: statusColor(w.status) }, `${statusIcon(w.status)} `)),
            h(
              Box,
              { flexGrow: 1, flexShrink: 1, minWidth: 8 },
              h(Text, { wrap: "truncate-end", bold: on }, w.title),
            ),
            h(
              Box,
              { flexShrink: 0 },
              h(Text, { dimColor: true }, `  ${statusName(w.status).padEnd(6, "　")}  ${when(w.updatedAt)}`),
            ),
          ),
      }),
  });
}

function WorkView(p: { data: Data; ref: string; project: number | null; height: number; active: boolean }) {
  const load = useLoad(() => p.data.work(p.ref, p.project), [p.ref, p.project]);
  return h(Pending<Awaited<ReturnType<Data["work"]>>>, {
    load,
    what: "作業",
    render: (w) =>
      w === null
        ? h(Text, { dimColor: true }, "この作業は無い（別のプロジェクトの作業か、消された）。")
        : h(
            Scroll,
            { height: p.height, active: p.active },
            h(
              Text,
              { key: "t", bold: true },
              `${statusIcon(w.status)} ${w.title}（${statusName(w.status)}）`,
            ),
            h(Text, { key: "p", dimColor: true }, `${ICONS.project} ${w.project}  ${when(w.updatedAt)}`),
            h(Text, { key: "g" }, `${ICONS.goal} 目的: ${w.goal}`),
            h(Text, { key: "c" }, `いま: ${w.current}`),
            ...w.next.map((n, i) => h(Text, { key: `n${i}` }, `${ICONS.next} ${n}`)),
            ...hitLines("q", ICONS.question, "問い", w.questions),
            ...hitLines("a", ICONS.avoid, "通ってはいけない道", w.walls),
          ),
  });
}

const hitLines = (key: string, icon: string, title: string, hits: Hit[]): ReactNode[] =>
  hits.length === 0
    ? []
    : [
        h(Text, { key: `${key}-h`, bold: true }, `${icon} ${title}`),
        ...hits.map((x) =>
          h(
            Text,
            { key: `${key}-${x.ref}`, color: kindColor(x.kind, x.status) },
            `  ${x.label} ${oneLine(x.text)}`,
          ),
        ),
      ];

function SearchView(p: {
  data: Data;
  project: number | null;
  height: number;
  width: number;
  active: boolean;
  typing: boolean;
  setTyping: (t: boolean) => void;
  open: (d: Detail) => void;
}) {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<Mode>("knowledge");
  const load = useLoad<Hit[] | null>(
    () => (question ? p.data.search(question, mode, p.project) : Promise.resolve(null)),
    [question, mode, p.project],
  );
  const hits = load.status === "ok" ? (load.value ?? []) : [];
  const [selected] = useSelection(hits.length, p.height - 3, p.active && !p.typing);
  useInput(
    (input, key) => {
      const hit = hits[selected];
      if (key.return && hit) p.open({ kind: "read", ref: hit.ref });
      else if (input === "m") setMode(mode === "knowledge" ? "said" : "knowledge");
      else if (input === "/" || input === "i") p.setTyping(true);
    },
    { isActive: p.active && !p.typing },
  );
  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      null,
      h(
        Text,
        { color: PALETTE.terracotta },
        // 狭い端末では見出しの語を省く（折れると入力の頭が 2 行目へ落ち、どこに打つかが分からなくなる）
        p.width < 60
          ? `${ICONS.search} ❯ `
          : `${ICONS.search} ${mode === "knowledge" ? "判断と文書" : "持ち主の発言"} ❯ `,
      ),
      h(TextInput, {
        isDisabled: !(p.active && p.typing),
        defaultValue: question,
        placeholder: p.width < 60 ? "語を打って Enter" : "語を打って Enter（m で判断 / 発言を切り替え）",
        onSubmit: (v) => {
          setQuestion(v.trim());
          p.setTyping(false);
        },
      }),
    ),
    h(Text, { dimColor: true }, question ? `「${question}」` : " "),
    question
      ? h(Pending<Hit[] | null>, {
          load,
          what: "検索の結果",
          render: () =>
            h(List<Hit>, {
              items: hits,
              selected,
              height: p.height - 3,
              // 語に切れない問い（ひらがなだけ・記号だけ）は引かずに 0 件になる。「無かった」と分ける
              empty:
                ftsQuery(question) === null
                  ? "引ける語が無い（ひらがなだけ・記号だけの問い）。漢字・カタカナ・英語の語で引く。"
                  : "当たらなかった。語を変えるか、m で発言を引く。",
              row: (x, on) =>
                h(
                  Box,
                  { flexGrow: 1 },
                  h(Box, { flexShrink: 0 }, h(Text, { color: kindColor(x.kind, x.status) }, `${x.label} `)),
                  h(
                    Box,
                    { flexGrow: 1, flexShrink: 1, minWidth: 8 },
                    h(
                      Text,
                      { wrap: "truncate-end", bold: on },
                      oneLine(x.heading ? `${x.heading} — ${x.text}` : x.text),
                    ),
                  ),
                  // プロジェクトの列は幅を決めて切る（名前の長さで行ごとに列がずれないように）
                  h(
                    Box,
                    { flexShrink: 0, width: 22, marginLeft: 2 },
                    h(Text, { dimColor: true, wrap: "truncate-end" }, x.project),
                  ),
                  // PR・issue の発言は端末のリンクにする。対応しない端末では URL を後ろに添える
                  x.url
                    ? // biome-ignore lint/correctness/noChildrenProp: ink-link の型が children を props の必須にしている
                      h(Link, { url: x.url, children: h(Text, { color: PALETTE.slate }, ` ${ICONS.link}`) })
                    : null,
                ),
            }),
        })
      : null,
  );
}

function ReadView(p: { data: Data; refId: string; project: number | null; height: number; active: boolean }) {
  const load = useLoad(() => p.data.read(p.refId, p.project), [p.refId, p.project]);
  return h(Pending<string | null>, {
    load,
    what: "全文",
    render: (text) =>
      text === null
        ? h(Text, { dimColor: true }, "この記録は無い（消されたか、選んだプロジェクトの外の記録）。")
        : h(
            Scroll,
            { height: p.height, active: p.active },
            ...text.split("\n").map((line, i) => h(Text, { key: i }, line || " ")),
          ),
  });
}

export function App({ data }: { data: Data }) {
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const [tab, setTab] = useState<Tab>("sessions");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [typing, setTyping] = useState(false);
  const [project, setProject] = useState<number | null>(data.here.project);
  const projectsLoad = useLoad(() => data.projects(), []);
  const projectList = projectsLoad.status === "ok" ? projectsLoad.value : [];
  const projectName =
    project === null
      ? "全部のプロジェクト"
      : (projectList.find((x) => x.id === project)?.name ??
        (project === data.here.project ? data.here.name : null) ??
        `#${project}`);
  // 失敗のときは名前を出さない。狭い端末で頭から切ると、何ができなかったかが消える
  const projectLabel =
    projectsLoad.status === "error"
      ? `${ICONS.error} プロジェクトの一覧を読めなかった`
      : `${ICONS.project} ${projectName}`;

  useInput((input, key) => {
    if (key.tab) {
      const i = TABS.findIndex((t) => t.key === tab);
      const next = TABS[(i + (key.shift ? TABS.length - 1 : 1)) % TABS.length];
      if (next) setTab(next.key);
      setDetail(null);
      setTyping(false);
      return;
    }
    if (typing) {
      if (key.escape) setTyping(false);
      return;
    }
    if (key.escape) setDetail(null);
    else if (input === "q") app.exit();
    else if (input === "/") {
      setTab("search");
      setDetail(null);
      setTyping(true);
    } else if (input === "p" && detail === null) {
      // プロジェクトを順に切り替える。最後の次は全部のプロジェクト。一覧を読めなくても、起動したプロジェクトへは戻れる
      const ids = [...new Set([...projectList.map((x) => x.id), data.here.project])].filter(
        (x): x is number => x !== null,
      );
      const cycle: (number | null)[] = [...ids, null];
      setProject(cycle[(cycle.indexOf(project) + 1) % cycle.length] ?? null);
    }
  });

  // 終わり方と戻り方、その画面にしか無いキーを先に置き、どの画面でも同じキーを後ろへ回す（入らなければ後ろから切れる）
  const items = detail
    ? [
        "q 終わる",
        "Esc 戻る",
        "↑↓ j k 動かす",
        "PgUp PgDn Space めくる",
        "g G 端へ",
        "/ 検索",
        "Tab S-Tab 画面",
      ]
    : typing
      ? ["Enter 引く", "Esc 打つのをやめる", "Tab 画面"]
      : [
          "q 終わる",
          "Enter 開く",
          ...(tab === "sessions" ? ["← → h l ページ"] : tab === "search" ? ["m 判断 / 発言", "i 打つ"] : []),
          "↑↓ j k 選ぶ",
          "PgUp PgDn めくる",
          "Tab S-Tab 画面",
          "/ 検索",
          "g G 端へ",
          "p プロジェクト",
        ];
  const packed = helpLines(items, columns - 2);
  // 2 行にすると一覧に 3 行が残らない高さでは 1 行に戻す（選んだ行が画面の外へ出る）
  const help = packed.length > 1 && rows - CHROME - 1 < 3 ? helpLines(items, columns - 2, 1) : packed;

  const height = Math.max(1, rows - CHROME - (help.length - 1));
  // タブの名前を出すと 1 行に収まらない幅では、アイコンだけにする（折れると上の枠が 4 行になり、画面がはみ出す）
  const narrow = columns < 64;
  // 詳細を開いている間も一覧は隠すだけで残す。作り直すと、選んでいた行・ページ・検索の語が Esc で消える
  const listActive = detail === null;
  const list =
    tab === "sessions"
      ? // プロジェクトを変えたら 1 ページ目から読み直す（前のプロジェクトのページ番号を持ち越すと、空のページを「無い」と出す）
        h(SessionList, {
          key: `sessions-${project ?? "all"}`,
          data,
          project,
          height,
          width: columns,
          active: listActive,
          open: setDetail,
        })
      : tab === "work"
        ? h(WorkList, { data, project, height, active: listActive, open: setDetail })
        : h(SearchView, {
            data,
            project,
            height,
            width: columns,
            active: listActive,
            typing,
            setTyping,
            open: setDetail,
          });
  const shown =
    detail?.kind === "session"
      ? h(SessionView, { data, id: detail.id, height, width: columns, active: true })
      : detail?.kind === "work"
        ? h(WorkView, { data, ref: detail.ref, project, height, active: true })
        : detail?.kind === "read"
          ? h(ReadView, { data, refId: detail.ref, project, height, active: true })
          : null;
  const body = [
    h(
      Box,
      { key: `list-${tab}`, display: listActive ? "flex" : "none", flexDirection: "column", flexGrow: 1 },
      list,
    ),
    shown ? h(Box, { key: "detail", flexDirection: "column", flexGrow: 1 }, shown) : null,
  ];

  return h(
    Box,
    { flexDirection: "column", height: rows, width: columns },
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: PALETTE.taupe,
        paddingX: 1,
        justifyContent: "space-between",
        height: 3,
        flexShrink: 0,
        overflow: "hidden",
      },
      h(
        Box,
        { gap: narrow ? 1 : 2, flexShrink: 0 },
        ...TABS.map((t) =>
          h(
            Text,
            {
              key: t.key,
              bold: t.key === tab,
              color: t.key === tab ? PALETTE.terracotta : PALETTE.taupe,
              inverse: t.key === tab,
            },
            narrow ? ` ${t.icon} ` : ` ${t.icon} ${t.label} `,
          ),
        ),
      ),
      h(
        Box,
        { flexShrink: 1, minWidth: 0, marginLeft: 1 },
        h(
          Text,
          {
            dimColor: projectsLoad.status !== "error",
            color: projectsLoad.status === "error" ? PALETTE.failure : undefined,
            wrap: projectsLoad.status === "error" ? "truncate-end" : "truncate-start",
          },
          projectLabel,
        ),
      ),
    ),
    h(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, overflow: "hidden" }, ...body),
    h(
      Box,
      { height: help.length, flexShrink: 0, flexDirection: "column" },
      ...help.map((line, i) => h(Text, { key: i, dimColor: true, wrap: "truncate-end" }, ` ${line}`)),
    ),
  );
}
