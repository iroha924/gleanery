// The dashboard screens: session list, session detail, work, and search. **Read only**; nothing here can start a write.
// Written with createElement instead of JSX. This repository runs src directly with Node's type stripping, and Node cannot read JSX.

import { stripVTControlCharacters } from "node:util";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useAnimation, useApp, useInput, useWindowSize } from "ink";
import Link from "ink-link";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { createElement as h, type ReactNode, useEffect, useRef, useState } from "react";
import { kindColor, PALETTE } from "../palette.ts";
import { inline, plain, width } from "../panel.ts";
import type { Hit } from "../search.ts";
import type { SessionDetail, SessionRow } from "../sessions.ts";
import { ftsQuery, reason } from "../text.ts";
import type { Data, Mode } from "./data.ts";
import { ICONS, statusIcon, TWINKLE } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";

const TABS = [
  { key: "sessions", label: "Sessions", icon: ICONS.sessions },
  { key: "work", label: "Work", icon: ICONS.work },
  { key: "search", label: "Search", icon: ICONS.search },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** A detail view open over a list. Esc returns to the list. */
type Detail = { kind: "session"; id: string } | { kind: "work"; ref: string } | { kind: "read"; ref: string };

/** Rows used by the top (tabs) and bottom (key help). The body height is what remains. */
const CHROME = 4;

/**
 * Fits the key help into `lines` rows at the given width. A key and its description are never split. Pairs that do not fit
 * are dropped from the end (important keys come first). Width uses panel.ts width (which counts symbols wide, so it errs toward fitting).
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

/** The host that recorded a conversation. The same word in the list and the detail */
const hostName = (origin: string) =>
  origin === "codex" ? "Codex" : origin === "claude-code" ? "Claude Code" : origin;

const STATUS: Record<string, string> = {
  active: "in progress",
  blocked: "blocked",
  paused: "on hold",
  done: "done",
  abandoned: "dropped",
};
const statusName = (status: string) => STATUS[status] ?? status;
/** Work status colors. Rosewood is reserved for "decisions to avoid" and "could not read", so blocked work is ochre */
const statusColor = (status: string) =>
  status === "blocked" ? PALETTE.ochre : status === "active" ? PALETTE.sage : undefined;

type Load<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; value: T };

/** Loading, failure, and success in one value. Reloads when deps change and drops stale responses. */
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: callers decide when to reload through deps
    deps,
  );
  return state;
}

/** The loading spinner (bounces through icons.ts TWINKLE). The symbol sits in a 2-column box so nearby text does not shift */
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

/** Loading and failure display. A failure starts with what could not be done. */
function Pending<T>({ load, what, render }: { load: Load<T>; what: string; render: (v: T) => ReactNode }) {
  if (load.status === "loading") return h(Twinkle, { label: `Loading ${what}…` });
  if (load.status === "error")
    return h(
      Text,
      { color: PALETTE.failure },
      `${ICONS.error} Could not read ${what}: ${oneLine(String(load.error))}`,
    );
  return h(Box, { flexDirection: "column", flexGrow: 1 }, render(load.value));
}

/** A list that draws only the rows around the selection. One row per line; the selected row is inverted. */
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

/** Selection moved with ↑↓ / j k. PageUp / PageDown move by the screen height. */
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

/** Long text. ↑↓ / j k move one line, PageUp / PageDown one screen. */
function Scroll({ height, active, children }: { height: number; active: boolean; children?: ReactNode }) {
  const ref = useRef<ScrollViewRef>(null);
  useInput(
    (input, key) => {
      const s = ref.current;
      if (!s) return;
      // scrollBy does not stop at the end and leaves the screen empty. Clamp to the end (getBottomOffset)
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
    what: "sessions",
    render: (v) => [
      h(
        Text,
        { key: "head", dimColor: true },
        `${v.total} sessions${pages > 1 ? ` (page ${page} of ${pages}, ← → to turn)` : ""}`,
      ),
      h(List<SessionRow>, {
        key: "list",
        items: v.items,
        selected,
        height: p.height - 1,
        empty: "No recorded sessions in this project yet.",
        row: (s, on) =>
          h(
            Box,
            { flexGrow: 1 },
            h(
              Box,
              { flexGrow: 1, flexShrink: 1, minWidth: 8 },
              h(Text, { wrap: "truncate-end", bold: on }, oneLine(s.title)),
            ),
            // The right column never shrinks; only the title is cut (shrinking drops the time and counts first on long titles and misaligns rows).
            // Narrow terminals show fewer fields
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

// Outside text (recorded PR and issue bodies, conversations, names, paths) passes through here right before display. Without dropping control sequences it could rewrite the screen
const oneLine = (s: string) => inline(s).replace(/\s+/g, " ").trim();
// Terminals advance tabs to the next 8-column stop, but Ink counts them as width 0 and misaligns rows, so they become spaces
const block = (s: string) => plain(s).replace(/\t/g, "  ");

/** Table rows drawn by marked-terminal (cli-table3): lines starting with a border, or starting and ending with │. A │ in prose does not match */
const TABLE_LINE = /^\s*(?:[┌├└]|│.*│\s*$)/u;

const speakerIcon: Record<string, string> = {
  self: ICONS.self,
  assistant: ICONS.assistant,
  person: ICONS.person,
  bot: ICONS.bot,
};
const speakerName: Record<string, string> = { self: "You", assistant: "AI", person: "Person", bot: "bot" };

function SessionView(p: { data: Data; id: string; height: number; width: number; active: boolean }) {
  const load = useLoad(() => p.data.session(p.id), [p.id]);
  return h(Pending<SessionDetail | null>, {
    load,
    what: "session",
    render: (s) =>
      s === null
        ? h(
            Text,
            { dimColor: true },
            "This session does not exist (it was deleted, or it is a GitHub conversation).",
          )
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
        `${ICONS.project} ${oneLine(s.project)}  ${s.branch ? `${ICONS.branch} ${oneLine(s.branch)}  ` : ""}${when(s.startedAt)}  ${hostName(s.origin)}`,
      ),
    ),
  ];
  for (const m of s.messages) {
    const files = m.files.map(
      (f) =>
        `${f.action === "edit" ? "edited" : f.action === "read" ? "read" : "reviewed"} ${oneLine(f.path)}`,
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
          `${speakerIcon[m.speaker] ?? ICONS.person} ${speakerName[m.speaker] ?? oneLine(m.speaker)}`,
          h(
            Text,
            { dimColor: true, bold: false },
            `  ${when(m.sentAt)}${m.truncated ? `  (cut from ${m.originalBytes} bytes)` : ""}`,
          ),
        ),
        h(
          Box,
          { paddingLeft: 2, flexDirection: "column" },
          ...(m.speaker === "assistant"
            ? renderMarkdown(block(m.body), body)
                .split("\n")
                .map((line, i) =>
                  // Table border lines break when wrapped, so they are cut. Ink wraps the body at the terminal width
                  h(
                    Text,
                    // Table rows start with a color control sequence, so strip it before checking
                    {
                      key: i,
                      wrap: TABLE_LINE.test(stripVTControlCharacters(line)) ? "truncate-end" : "wrap",
                    },
                    line || " ",
                  ),
                )
            : [h(Text, { key: "b" }, block(m.body))]),
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
        h(Text, { bold: true }, `${ICONS.decision} Records traced in this session`),
        ...s.knowledge.map((k) =>
          h(
            Text,
            { key: k.id, color: kindColor(k.kind, k.status) },
            `  ${k.label} ${oneLine(k.body)}${k.reason ? ` (${oneLine(k.reason)})` : ""}`,
          ),
        ),
      ),
    );
  for (const w of s.work)
    out.push(
      h(
        Text,
        { key: w.ref },
        `${statusIcon(w.status)} Work: ${oneLine(w.title)}(${statusName(w.status)}) Now: ${oneLine(w.current)}`,
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
  const items = load.status === "ok" ? load.value.items : [];
  // One row goes to the "cut" notice. When only one list row would remain, the notice is not shown
  const more = load.status === "ok" && load.value.more && p.height >= 2;
  const height = more ? p.height - 1 : p.height;
  const [selected] = useSelection(items.length, height, p.active);
  useInput(
    (_input, key) => {
      const w = items[selected];
      if (key.return && w) p.open({ kind: "work", ref: w.ref });
    },
    { isActive: p.active },
  );
  return h(Pending<{ items: typeof items; more: boolean }>, {
    load,
    what: "work",
    render: (works) =>
      h(
        Box,
        { flexDirection: "column" },
        ...(more
          ? [
              h(
                Text,
                { key: "more", dimColor: true, wrap: "truncate-end" },
                `Latest ${works.items.length} (older work omitted)`,
              ),
            ]
          : []),
        h(List<(typeof items)[number]>, {
          key: "list",
          items: works.items,
          selected,
          height,
          empty: "No traced work yet. Record where work stands with trace (/gleanery:trace).",
          row: (w, on) =>
            h(
              Box,
              { flexGrow: 1 },
              h(
                Box,
                { flexShrink: 0 },
                h(Text, { color: statusColor(w.status) }, `${statusIcon(w.status)} `),
              ),
              h(
                Box,
                { flexGrow: 1, flexShrink: 1, minWidth: 8 },
                h(Text, { wrap: "truncate-end", bold: on }, oneLine(w.title)),
              ),
              h(
                Box,
                { flexShrink: 0 },
                h(
                  Text,
                  { dimColor: true },
                  `  ${statusName(w.status).padEnd(11, " ")}  ${when(w.updatedAt)}`,
                ),
              ),
            ),
        }),
      ),
  });
}

function WorkView(p: { data: Data; ref: string; project: number | null; height: number; active: boolean }) {
  const load = useLoad(() => p.data.work(p.ref, p.project), [p.ref, p.project]);
  return h(Pending<Awaited<ReturnType<Data["work"]>>>, {
    load,
    what: "work",
    render: (w) =>
      w === null
        ? h(
            Text,
            { dimColor: true },
            "This work does not exist (it belongs to another project, or was deleted).",
          )
        : h(
            Scroll,
            { height: p.height, active: p.active },
            h(
              Text,
              { key: "t", bold: true },
              `${statusIcon(w.status)} ${oneLine(w.title)} (${statusName(w.status)})`,
            ),
            h(
              Text,
              { key: "p", dimColor: true },
              `${ICONS.project} ${oneLine(w.project)}  ${when(w.updatedAt)}`,
            ),
            h(Text, { key: "g" }, `${ICONS.goal} Goal: ${block(w.goal)}`),
            h(Text, { key: "c" }, `Now: ${block(w.current)}`),
            ...w.next.map((n, i) => h(Text, { key: `n${i}` }, `${ICONS.next} ${block(n)}`)),
            ...hitLines("q", ICONS.question, "Questions", w.questions),
            ...hitLines("a", ICONS.avoid, "Paths to avoid", w.walls),
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
        // Narrow terminals drop the heading word (if it wraps, the input start falls to the second line and it is unclear where to type)
        p.width < 60
          ? `${ICONS.search} ❯ `
          : `${ICONS.search} ${mode === "knowledge" ? "Decisions and docs" : "Your messages"} ❯ `,
      ),
      h(TextInput, {
        isDisabled: !(p.active && p.typing),
        defaultValue: question,
        placeholder:
          p.width < 60
            ? "Type terms, then Enter"
            : "Type terms, then Enter (m switches decisions / messages)",
        onSubmit: (v) => {
          setQuestion(v.trim());
          p.setTyping(false);
        },
      }),
    ),
    h(Text, { dimColor: true }, question ? `"${question}"` : " "),
    question
      ? h(Pending<Hit[] | null>, {
          load,
          what: "search results",
          render: () =>
            h(List<Hit>, {
              items: hits,
              selected,
              height: p.height - 3,
              // Questions with no searchable terms (only hiragana or symbols) return 0 hits without searching. Keep that apart from "none found"
              empty:
                ftsQuery(question) === null
                  ? "No searchable terms (only hiragana or symbols). Search with kanji, katakana, or English words."
                  : "No matches. Try other terms, or press m to search messages.",
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
                  // The project column has a fixed width and is cut (so rows do not misalign with name length)
                  h(
                    Box,
                    { flexShrink: 0, width: 22, marginLeft: 2 },
                    h(Text, { dimColor: true, wrap: "truncate-end" }, oneLine(x.project)),
                  ),
                  // Messages from PRs and issues become terminal links. Terminals without link support get the URL appended
                  x.url
                    ? h(Link, {
                        url: oneLine(x.url),
                        // biome-ignore lint/correctness/noChildrenProp: ink-link types children as a required prop
                        children: h(Text, { color: PALETTE.slate }, ` ${ICONS.link}`),
                      })
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
    what: "full text",
    render: (text) =>
      text === null
        ? h(
            Text,
            { dimColor: true },
            "This record does not exist (it was deleted, or it is outside the selected project).",
          )
        : h(
            Scroll,
            { height: p.height, active: p.active },
            ...block(text)
              .split("\n")
              .map((line, i) => h(Text, { key: i }, line || " ")),
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
      ? "All projects"
      : (projectList.find((x) => x.id === project)?.name ??
        (project === data.here.project ? data.here.name : null) ??
        `#${project}`);
  // On failure no name is shown. Cutting from the start in a narrow terminal would hide what failed
  const projectLabel =
    projectsLoad.status === "error"
      ? `${ICONS.error} Could not read the project list`
      : `${ICONS.project} ${oneLine(projectName)}`;

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
      // Cycle through projects. After the last comes all projects. Even if the list cannot be read, the starting project is reachable
      const ids = [...new Set([...projectList.map((x) => x.id), data.here.project])].filter(
        (x): x is number => x !== null,
      );
      const cycle: (number | null)[] = [...ids, null];
      setProject(cycle[(cycle.indexOf(project) + 1) % cycle.length] ?? null);
    }
  });

  // Quit, back, and screen-specific keys come first; keys shared by every screen come last (cut from the end when they do not fit)
  const items = detail
    ? [
        "q quit",
        "Esc back",
        "↑↓ j k scroll",
        "PgUp PgDn Space page",
        "g G ends",
        "/ search",
        "Tab S-Tab screens",
      ]
    : typing
      ? ["Enter search", "Esc stop typing", "Tab screens"]
      : [
          "q quit",
          "Enter open",
          ...(tab === "sessions"
            ? ["← → h l page"]
            : tab === "search"
              ? ["m decisions / messages", "i type"]
              : []),
          "↑↓ j k select",
          "PgUp PgDn page",
          "Tab S-Tab screens",
          "/ search",
          "g G ends",
          "p project",
        ];
  const packed = helpLines(items, columns - 2);
  // Two rows fall back to one when fewer than 3 list rows would remain (the selected row would leave the screen)
  const help = packed.length > 1 && rows - CHROME - 1 < 3 ? helpLines(items, columns - 2, 1) : packed;

  const height = Math.max(1, rows - CHROME - (help.length - 1));
  // Show only icons when tab names do not fit on one line (wrapping makes the top frame 4 rows and the screen overflows)
  const narrow = columns < 64;
  // While a detail is open the list is only hidden. Recreating it would lose the selected row, page, and search terms on Esc
  const listActive = detail === null;
  const list =
    tab === "sessions"
      ? // A project change reloads from page 1 (carrying the old page number over would show an empty page as "none")
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
