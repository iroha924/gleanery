// IR を DB へ取り込む。
//
// 何を列にして何を JSONB に入れるかの規則:
//   列   = WHERE / ORDER BY / JOIN / 一意制約 に現れるもの
//   JSONB = 取り出して人か LLM が読むだけのもの
//
// polarity（極性）を列に出すのが要点。「触ると決めた」と「触らないと決めた」は
// 埋め込み空間でほぼ同じ位置に来るので、否定形の検索はベクトルでは当たらない。
// 取り込み時に機械が決めて列に入れる。

import crypto from "node:crypto";
import type pg from "pg";
import { EMBED_MODEL, type Env, embed, vec } from "./db.ts";
import { type Polarity, scopeFamily } from "./search.ts";

const sha = (s: unknown): string => crypto.createHash("sha256").update(String(s)).digest("hex");
const arr = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

export type Evidence = { kind: string; ref: string; note?: string; exit?: number };

/** progress-log スキルが書き出す IR のうち、取り込みが読む部分だけ。 */
export type Ir = {
  schema: string;
  meta: {
    id: string;
    title: string;
    status: string;
    branch?: string;
    hosts?: string[];
    created: string;
    updated: string;
  };
  background?: { problem?: string; goal?: string; nonGoals?: string[]; constraints?: string[] };
  current?: { at?: string; text?: string; phases?: unknown[] };
  next?: unknown[];
  decisions?: {
    id: string;
    decision: string;
    at: string;
    status?: string;
    context?: string;
    confirmation?: string;
    consequences?: string;
    supersededBy?: string;
    options?: { option: string; whyNot?: string; chosen?: boolean }[];
    evidence?: Evidence[];
  }[];
  events?: {
    id: string;
    kind: string;
    text: string;
    at: string;
    confidence?: string;
    evidence?: Evidence[];
  }[];
  verification?: {
    id: string;
    what: string;
    at: string;
    result?: string;
    cmd?: string;
    output?: string;
    whyNotRun?: string;
    verifies?: string;
    evidence?: Evidence[];
  }[];
  openQuestions?: { id: string; q: string; at: string; who?: string; when?: string; blocking?: boolean }[];
  links?: {
    issues?: { key?: string; url?: string; title?: string; state?: string; fetched?: boolean }[];
    prs?: { number: number; title?: string; state?: string; url?: string }[];
    commits?: { sha: string; subject?: string }[];
    files?: string[];
    urls?: { url?: string; note?: string }[];
  };
  session?: { id: string; host: "claude-code" | "codex" };
  utterances?: { key: string; ordinal: number; at: string; role: "human" | "ai"; text: string }[];
};

type Node = {
  kind: string;
  subkind?: string | null | undefined;
  key: string;
  text: string;
  at?: string | null | undefined;
  status?: string | null | undefined;
  confidence?: string | null | undefined;
  extra?: string | null | undefined;
  parentKey?: string | undefined;
  ordinal?: number | undefined;
  attrs?: Record<string, unknown> | undefined;
  evidence?: Evidence[] | undefined;
  actorKind?: "human" | "ai" | "ci" | "unknown" | undefined;
  actorName?: string | null | undefined;
  kindLabel?: string | undefined;
  polarity: Polarity;
  contentHash: string;
};

/** 極性は宣言させない。種別と場所から決まる。 */
function polarityOf(kind: string, subkind?: string | null): Polarity {
  if (kind === "boundary") return "dont"; // nonGoals / constraints
  if (kind === "option") return subkind === "chosen" ? "do" : "dont";
  if (kind === "event" && subkind === "dead_end") return "dont";
  if (kind === "event" && subkind === "debt") return "dont"; // 直しにいかない
  if (kind === "decision") {
    // 決定は 4 つの status を取る。accepted 以外を do にすると、却下した決定と
    // 後で覆した決定が「採用済み」として返り、「触らないと決めなかったか」への答えが逆になる。
    if (subkind === "accepted") return "do";
    if (subkind === "rejected" || subkind === "superseded") return "dont";
    return "na"; // proposed。まだ何も決まっていない
  }
  // **落ちた検証は行き止まりである。**確かめて駄目だったという観測なので、
  // 「試して駄目だったこと」を引く道具（only_rejected_or_forbidden）に出ないと、
  // 直っていないものが検索から構造的に外れる。
  // not-run は「まだ確かめていない」で、駄目だったという主張ではないので na のまま。
  if (kind === "verification") return subkind === "fail" ? "dont" : "na";
  return "na";
}

/** 配列を n 件ずつに割る。**1 文の引数が大きくなりすぎるのを避けるためだけ**にある。 */
function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** 埋め込みに渡す本文。**周りの文脈を前置きする。**
 *  チャンクだけでは「どの作業のいつの話か」が失われる。
 *  この IR は repo / 種別 / 時刻を構造として持っているので、推測せずに付けられる。 */
function embedText(ir: Ir, n: Pick<Node, "text" | "extra" | "kindLabel">): string {
  const head = [ir.meta.title, n.kindLabel].filter(Boolean).join(" / ");
  return `${head}\n${n.text}${n.extra ? `\n${n.extra}` : ""}`;
}

const KIND_LABEL: Record<string, string> = {
  decision: "意思決定",
  option: "検討した案",
  event: "経過",
  verification: "検証",
  question: "未解決の問い",
  boundary: "境界",
  utterance: "作業中のやりとり",
};

/** IR を node の平たい配列へ落とす。 */
export function flatten(ir: Ir): Node[] {
  const out: Node[] = [];
  const push = (o: Omit<Node, "polarity" | "contentHash" | "kindLabel">) => {
    const base = { ...o, kindLabel: KIND_LABEL[o.kind], polarity: polarityOf(o.kind, o.subkind) };
    // **埋め込みへ渡す文そのものをハッシュする。**再取得の要否をこの値で決めているので、
    // 渡す文に入るのにハッシュに入らない要素があると、古い埋め込みが残り続ける。
    // 実測: 記録の題だけを変えたとき、embed_text は変わるのにハッシュが一致して再取得されなかった。
    out.push({ ...base, contentHash: sha(embedText(ir, base)) });
  };

  for (const u of arr(ir.utterances)) {
    push({
      kind: "utterance",
      subkind: "session",
      key: u.key,
      ordinal: u.ordinal,
      at: u.at,
      text: u.text,
      actorKind: u.role,
      actorName: u.role === "ai" ? (ir.session?.host ?? null) : null,
      attrs: { session: ir.session?.id ?? null, role: u.role },
    });
  }

  for (const b of arr(ir.background?.nonGoals)) {
    push({
      kind: "boundary",
      subkind: "non-goal",
      key: `non-goal:${sha(b).slice(0, 8)}`,
      text: b,
      at: ir.meta.created,
    });
  }
  for (const b of arr(ir.background?.constraints)) {
    push({
      kind: "boundary",
      subkind: "constraint",
      key: `constraint:${sha(b).slice(0, 8)}`,
      text: b,
      at: ir.meta.created,
    });
  }
  for (const d of arr(ir.decisions)) {
    push({
      kind: "decision",
      // status を subkind に載せる。極性も検索時の札もここからしか決まらない。
      subkind: d.status ?? null,
      key: d.id,
      text: d.decision,
      at: d.at,
      status: d.status,
      extra: d.context,
      attrs: {
        context: d.context,
        confirmation: d.confirmation,
        consequences: d.consequences,
        supersededBy: d.supersededBy,
      },
      evidence: d.evidence,
    });
    arr(d.options).forEach((o, i) => {
      push({
        kind: "option",
        // **覆された決定の「採った案」を、採用のまま返さない。**
        // 決定は superseded で dont に落ちるのに、配下の chosen は do のままで
        // 【採用した案】として返っていた（実測 2 件）。訂正を superseded で記録するたび増える。
        //
        // **`rejected` へ寄せない。**「かつて採った案」であることが札から消え、
        // しかも chosen だった案には whyNot が無いので、理由の空いた棄却案に見える。
        // **status が書かれていない決定は落とさない** — 決定自体が na なのに、
        // 書かれていない値から配下の否定を作ることになる。
        subkind: o.chosen
          ? d.status === "superseded" || d.status === "rejected"
            ? "was-chosen"
            : "chosen"
          : "rejected",
        key: `${d.id}:${i}`,
        parentKey: d.id,
        ordinal: i,
        text: o.option,
        at: d.at,
        extra: o.whyNot,
        attrs: { whyNot: o.whyNot ?? null, chosen: Boolean(o.chosen) },
      });
    });
  }
  for (const e of arr(ir.events)) {
    push({
      kind: "event",
      subkind: e.kind,
      key: e.id,
      text: e.text,
      at: e.at,
      confidence: e.confidence,
      attrs: {},
      evidence: e.evidence,
    });
  }
  for (const v of arr(ir.verification)) {
    push({
      kind: "verification",
      // **result を subkind に載せる。**札は subkind からしか決まらないので、
      // status 列だけに入れていたときは pass も fail も「【検証】」で返っていた。
      // decision が status を subkind に載せているのと同じ形（上の 158 行）。
      subkind: v.result ?? null,
      key: v.id,
      text: v.what,
      at: v.at,
      status: v.result,
      extra: [v.cmd, v.output, v.whyNotRun].filter(Boolean).join("\n"),
      attrs: {
        cmd: v.cmd ?? null,
        output: v.output ?? null,
        whyNotRun: v.whyNotRun ?? null,
        verifies: v.verifies ?? null,
      },
      evidence: v.evidence,
    });
  }
  for (const q of arr(ir.openQuestions)) {
    push({
      kind: "question",
      key: q.id,
      text: q.q,
      at: q.at,
      status: q.blocking ? "blocking" : "open",
      attrs: { who: q.who, when: q.when, blocking: Boolean(q.blocking) },
    });
  }
  return out;
}

export type IngestResult = {
  nodes: number;
  embedded: number;
  scopeId: number;
  /** 別の作業場所から取り込み直したとき、記録が元の場所に留まったことを示す */
  keptScope: number | null;
};

export async function ingest(
  client: pg.Client,
  env: Env,
  ir: Ir,
  scopeId: number,
  { onProgress }: { onProgress?: (m: string) => void } = {},
): Promise<IngestResult> {
  const nodes = flatten(ir);
  const say = (m: string) => onProgress?.(m);

  await client.query("begin");
  try {
    // 記録。raw を持つので、投影はいつでも作り直せる。
    const recText = [ir.meta.title, ir.background?.problem, ir.background?.goal].filter(Boolean).join("\n");
    const recEmbed = (await embed(env, [recText], "document"))[0];
    // 記録の scope は最初に取り込んだものを正本にする。あとから別のディレクトリで
    // 取り込み直したとき、新しい要素だけが別 scope に入ると 1 つの記録が 2 つに割れる。
    const existingScope = (
      await client.query<{ s: number }>("select scope_id::int as s from record where id = $1", [ir.meta.id])
    ).rows[0]?.s;
    // **他人の記録を id だけで書き換えられないようにする。**id は
    // `invoice-pdf-export` のような意味のある語を推奨しているので推測できる。
    // 束の中（ポリリポ）は同じ作業とみなし、それ以外の作業場所の記録は触らせない。
    if (existingScope !== undefined && existingScope !== scopeId) {
      const family = await scopeFamily(client, scopeId);
      if (!family.includes(existingScope)) {
        throw new Error(
          `記録 "${ir.meta.id}" は別の作業場所のものなので、ここからは更新できない。` +
            `同じ作業なら knowledge link で束ねる。別の作業なら meta.id を変える`,
        );
      }
    }
    const effectiveScope = existingScope ?? scopeId;
    const humanActor = nodes.some((node) => node.actorKind === "human")
      ? ((await client.query<{ display: string }>("select display from person where is_me limit 1")).rows[0]
          ?.display ?? null)
      : null;
    await client.query(
      `insert into record (id, scope_id, schema_ver, title, status, branch, hosts, problem, goal,
                           current_at, current_text, phases, next, created_at, updated_at, raw, raw_hash, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (id) do update set
         title=excluded.title, status=excluded.status, branch=excluded.branch, hosts=excluded.hosts,
         problem=excluded.problem, goal=excluded.goal, current_at=excluded.current_at,
         current_text=excluded.current_text, phases=excluded.phases, next=excluded.next,
         updated_at=excluded.updated_at, raw=excluded.raw, raw_hash=excluded.raw_hash,
         embedding=excluded.embedding, ingested_at=now()`,
      [
        ir.meta.id,
        effectiveScope,
        ir.schema,
        ir.meta.title,
        ir.meta.status,
        ir.meta.branch ?? null,
        arr(ir.meta.hosts),
        ir.background?.problem ?? "",
        ir.background?.goal ?? "",
        ir.current?.at ?? null,
        ir.current?.text ?? null,
        JSON.stringify(arr(ir.current?.phases)),
        JSON.stringify(arr(ir.next)),
        ir.meta.created,
        ir.meta.updated,
        JSON.stringify(ir),
        sha(JSON.stringify(ir)),
        vec(recEmbed),
      ],
    );
    say(`record ${ir.meta.id}`);

    // 埋め込みは content_hash が変わったものだけ取り直す。
    const existing = new Map(
      (
        await client.query<{ kind: string; key: string; content_hash: string; has_emb: boolean }>(
          "select kind, key, content_hash, embedding is not null as has_emb from node where record_id=$1",
          [ir.meta.id],
        )
      ).rows.map((r) => [`${r.kind}|${r.key}`, r]),
    );
    const need = nodes.filter((n) => {
      const e = existing.get(`${n.kind}|${n.key}`);
      return !e || e.content_hash !== n.contentHash || !e.has_emb;
    });
    say(`node ${nodes.length} 件 / 埋め込みを取り直す ${need.length} 件`);
    const vectors = need.length
      ? await embed(
          env,
          need.map((n) => embedText(ir, n)),
          "document",
        )
      : [];
    const byKey = new Map(need.map((n, i) => [`${n.kind}|${n.key}`, vectors[i]]));

    // **1 件ずつ upsert しない。**往復数がそのまま時間になる。
    // 実測（2026-09-09、Neon / Singapore）: node 746 件を 1 件ずつ投げると取り込み全体で 77 秒。
    // 往復は片道 100ms 前後あるので、件数が増えるほど線形に伸びる。
    // **配列を 1 つ渡して unnest で展開する。**`vector[]` は null 混じりでも通る（実測）。
    //
    // **バッチの中で同じキーが 2 回出ると `ON CONFLICT DO UPDATE` が落ちる**
    // （cannot affect row a second time）ので、投げる前に畳む。1 件ずつのときは
    // 2 回 upsert されて後勝ちになっていたので、同じ結果になるよう後を残す。
    const uniq = new Map(nodes.map((n) => [`${n.kind}|${n.key}`, n]));
    const rows = [...uniq.values()];
    const idOf = new Map<string, number>();
    for (const part of chunks(rows, 500)) {
      const r = await client.query<{ id: number; kind: string; key: string }>(
        `insert into node (record_id, scope_id, kind, key, ordinal, at, text, subkind, status,
                           polarity, confidence, attrs, actor_kind, actor_name, content_hash,
                           embed_text, embed_model, embedded_at, embedding)
         select $1, $2, t.kind, t.key, t.ordinal, t.at, t.text, t.subkind, t.status,
                t.polarity, t.confidence, t.attrs, t.actor_kind, t.actor_name, t.content_hash,
                t.embed_text, t.embed_model, t.embedded_at, t.embedding
         from unnest($3::text[], $4::text[], $5::int[], $6::timestamptz[], $7::text[], $8::text[], $9::text[],
                     $10::text[], $11::text[], $12::jsonb[], $13::text[], $14::text[], $15::text[],
                     $16::text[], $17::text[], $18::timestamptz[], $19::extensions.vector[])
              as t(kind, key, ordinal, at, text, subkind, status, polarity, confidence, attrs,
                   actor_kind, actor_name, content_hash, embed_text, embed_model, embedded_at, embedding)
         on conflict (record_id, kind, key) do update set
           scope_id=excluded.scope_id, ordinal=excluded.ordinal, at=excluded.at, text=excluded.text, subkind=excluded.subkind,
           status=excluded.status, polarity=excluded.polarity, confidence=excluded.confidence,
           attrs=excluded.attrs, actor_kind=excluded.actor_kind, actor_name=excluded.actor_name,
           content_hash=excluded.content_hash, deleted_at=null,
           embed_text=coalesce(excluded.embed_text, node.embed_text),
           embed_model=coalesce(excluded.embed_model, node.embed_model),
           embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
           embedding=coalesce(excluded.embedding, node.embedding)
         returning id, kind, key`,
        [
          ir.meta.id,
          effectiveScope,
          part.map((n) => n.kind),
          part.map((n) => n.key),
          part.map((n) => n.ordinal ?? 0),
          part.map((n) => n.at ?? null),
          part.map((n) => n.text),
          part.map((n) => n.subkind ?? null),
          part.map((n) => n.status ?? null),
          part.map((n) => n.polarity),
          part.map((n) => n.confidence ?? null),
          part.map((n) => JSON.stringify(n.attrs ?? {})),
          part.map((n) => n.actorKind ?? null),
          part.map((n) => n.actorName ?? (n.actorKind === "human" ? humanActor : null)),
          part.map((n) => n.contentHash),
          part.map((n) => (byKey.get(`${n.kind}|${n.key}`) ? embedText(ir, n) : null)),
          part.map((n) => (byKey.get(`${n.kind}|${n.key}`) ? EMBED_MODEL : null)),
          part.map((n) => (byKey.get(`${n.kind}|${n.key}`) ? new Date().toISOString() : null)),
          part.map((n) => vec(byKey.get(`${n.kind}|${n.key}`))),
        ],
      );
      for (const x of r.rows) idOf.set(`${x.kind}|${x.key}`, x.id);
    }
    for (const n of rows) {
      if (!idOf.has(`${n.kind}|${n.key}`)) {
        throw new Error(`node の upsert が id を返さなかった: ${n.kind}|${n.key}`);
      }
    }

    // 外部の実体（issue / PR / commit / file / url）を登録して node へ結ぶ。
    // ここが埋まらないと、パスの完全一致で「このファイルは触らないと決めた」を引けない。
    //
    // **集めてから 1 回で入れる。**1 件ずつだと ref と ref_link で 2 往復ずつ掛かり、
    // evidence の数だけ線形に伸びる（node の upsert と同じ理由）。
    type RefRow = {
      kind: string;
      key: string;
      repo?: string;
      title?: string;
      state?: string;
      url?: string;
      fetched?: boolean;
    };
    type LinkRow = {
      kind: string;
      key: string;
      repo?: string;
      role: string;
      nodeId: number | null;
      note: string | null;
      exit: number | null;
    };
    const refs = new Map<string, RefRow>();
    const links: LinkRow[] = [];
    const refKey = (kind: string, key: string, repo?: string) => `${kind}|${repo ?? ""}|${key}`;
    const putRef = (
      kind: string,
      key: string | null | undefined,
      extra: Omit<RefRow, "kind" | "key"> = {},
    ): void => {
      if (!key) return;
      const k = refKey(kind, String(key), extra.repo);
      const prev = refs.get(k);
      // 同じ ref が 2 回出たときは、後から来た非 null で上書きする
      // （1 件ずつ upsert していたときの coalesce と同じ結果になる）。
      refs.set(k, {
        ...(prev ?? { kind, key: String(key) }),
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)),
      } as RefRow);
    };
    // **repo も運ぶ。**引き当てのキーは `putRef` と同じ形でないと、repo を持つ ref だけ
    // 辺が張られなくなる（いまは repo を渡す呼び出し元が無いので表に出ていない）。
    const linkRef = (
      kind: string,
      key: string | null | undefined,
      role: string,
      nodeId: number | null = null,
      note: string | null = null,
      exit: number | null = null,
      repo?: string,
    ): void => {
      if (!key) return;
      links.push({ kind, key: String(key), repo, role, nodeId, note, exit });
    };

    for (const n of rows) {
      const nodeId = idOf.get(`${n.kind}|${n.key}`) ?? null;
      for (const e of arr(n.evidence)) {
        if (!["file", "commit", "url", "issue", "command"].includes(e.kind)) continue;
        // ファイルは行番号を落として登録する。行が違っても同じファイルとして引きたい。
        const key = e.kind === "file" ? String(e.ref).split(":")[0] : String(e.ref);
        putRef(e.kind, key);
        linkRef(e.kind, key, "evidence", nodeId, e.note ?? null, e.exit ?? null);
      }
    }
    for (const i of arr(ir.links?.issues)) {
      const key = i.key ?? i.url;
      putRef("issue", key, { title: i.title, state: i.state, url: i.url, fetched: i.fetched });
      linkRef("issue", key, "link");
    }
    for (const p of arr(ir.links?.prs)) {
      putRef("pr", String(p.number), { title: p.title, state: p.state, url: p.url });
      linkRef("pr", String(p.number), "link");
    }
    for (const cm of arr(ir.links?.commits)) {
      putRef("commit", cm.sha, { title: cm.subject });
      linkRef("commit", cm.sha, "link");
    }
    for (const f of arr(ir.links?.files)) {
      const key = String(f).split(":")[0];
      putRef("file", key);
      linkRef("file", key, "touched");
    }
    // **URL も入れる。**ここにループが無かったので、IR に書いた参照が黙って落ちていた
    // （実測: personal-rebuild に 3 件。`raw` には残るが、どこからも引けない状態だった）。
    for (const u of arr(ir.links?.urls)) {
      if (!u?.url) continue;
      putRef("url", u.url, { url: u.url });
      linkRef("url", u.url, "link", null, u.note ?? null);
    }

    const refId = new Map<string, number>();
    for (const part of chunks([...refs.values()], 500)) {
      const r = await client.query<{ id: number; kind: string; repo: string | null; key: string }>(
        `insert into ref (kind, repo, key, title, state, url, fetched)
         select t.kind, t.repo, t.key, t.title, t.state, t.url, t.fetched
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[])
              as t(kind, repo, key, title, state, url, fetched)
         on conflict (kind, coalesce(repo,''), key) do update set
           title=coalesce(excluded.title, ref.title), state=coalesce(excluded.state, ref.state),
           url=coalesce(excluded.url, ref.url), fetched=coalesce(excluded.fetched, ref.fetched)
         returning id, kind, repo, key`,
        [
          part.map((x) => x.kind),
          part.map((x) => x.repo ?? null),
          part.map((x) => x.key),
          part.map((x) => x.title ?? null),
          part.map((x) => x.state ?? null),
          part.map((x) => x.url ?? null),
          part.map((x) => x.fetched ?? null),
        ],
      );
      for (const x of r.rows) refId.set(refKey(x.kind, x.key, x.repo ?? undefined), x.id);
    }

    // **辺も畳んでから入れる。**同じ (ref, role, node) が 2 回出ると
    // `ON CONFLICT DO NOTHING` でも 1 文の中では弾かれない代わりに無駄な行を運ぶ。
    const linkRows = new Map<string, LinkRow & { id: number }>();
    for (const l of links) {
      const id = refId.get(refKey(l.kind, l.key, l.repo));
      // **引けなかったら止める。**node 側は id が返らなければ投げるのに、ここだけ黙って
      // 捨てると、`ref` の upsert を `DO NOTHING` に変えた瞬間に辺が丸ごと落ちても気付けない。
      if (id === undefined) throw new Error(`ref の id を引けなかった: ${l.kind}|${l.key}`);
      // **先に来たものを残す。**1 件ずつ `on conflict do nothing` で投げていたときと
      // 同じ結果にする（同じ (ref, role, node) が 2 回出たら note と exit_code は先勝ち）。
      const k = `${id}|${l.role}|${l.nodeId ?? 0}`;
      if (!linkRows.has(k)) linkRows.set(k, { ...l, id });
    }
    for (const part of chunks([...linkRows.values()], 500)) {
      await client.query(
        `insert into ref_link (ref_id, record_id, node_id, role, note, exit_code)
         select t.ref_id, $1, t.node_id, t.role, t.note, t.exit_code
         from unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::int[])
              as t(ref_id, node_id, role, note, exit_code)
         on conflict (ref_id, record_id, role, coalesce(node_id, 0)) do nothing`,
        [
          ir.meta.id,
          part.map((x) => x.id),
          part.map((x) => x.nodeId),
          part.map((x) => x.role),
          part.map((x) => x.note),
          part.map((x) => x.exit),
        ],
      );
    }

    // 親子（option → decision）。**1 件ずつ update しない** — 決定の数だけ往復が増える。
    const parents = rows
      .filter((n) => n.parentKey)
      .map((n) => ({
        child: idOf.get(`${n.kind}|${n.key}`),
        parent: idOf.get(`decision|${n.parentKey}`) ?? null,
      }))
      .filter((x): x is { child: number; parent: number | null } => x.child !== undefined);
    for (const part of chunks(parents, 500)) {
      await client.query(
        `update node set parent_id = t.parent
         from unnest($1::bigint[], $2::bigint[]) as t(child, parent)
         where node.id = t.child`,
        [part.map((x) => x.child), part.map((x) => x.parent)],
      );
    }

    // **辺を作る。**IR は「この検証がどの決定を確かめたか」「どの決定がどれを覆したか」を
    // 持っているのに、attrs へ文字列として入れるだけで relation 表が空のままだった
    // （実測: 8 種類の辺が 1 本も無く、検証 82 件のうち 61 件が決定を指していた）。
    // 文字列のままだと「決めたのに確かめていない」を数えられない。
    // **この記録が張った辺は、いったん外してから張り直す。**追記だけだと、
    // IR から検証を取り除いても辺が残り、「確かめた」と読める状態が消えない。
    // 人が結んだ辺と自動で見つけた辺（source が record 以外）は触らない。
    await client.query(
      `delete from relation r using node n
       where r.from_node = n.id and n.record_id = $1 and r.source = 'record'`,
      [ir.meta.id],
    );
    const edges = new Map<string, { from: number; to: number; kind: string }>();
    for (const [fromKind, fromKey, toKey, kind] of [
      ...arr(ir.verification).flatMap((v) =>
        v.verifies ? ([["verification", v.id, v.verifies, "verifies"]] as const) : [],
      ),
      // A が B に覆されたなら、辺は「B が A を覆す」向き。
      ...arr(ir.decisions).flatMap((d) =>
        d.supersededBy ? ([["decision", d.supersededBy, d.id, "supersedes"]] as const) : [],
      ),
    ] as [string, string, string, string][]) {
      const from = idOf.get(`${fromKind}|${fromKey}`);
      const to = idOf.get(`decision|${toKey}`);
      // **別の記録を指す参照はここでは結ばない。**この記録の node しか手元に無い。
      // 結べなかったことは attrs に文字列として残るので、失われはしない。
      if (from === undefined || to === undefined || from === to) continue;
      edges.set(`${from}|${to}|${kind}`, { from, to, kind });
    }
    for (const part of chunks([...edges.values()], 500)) {
      await client.query(
        `insert into relation (from_node, to_node, kind, source)
         select t.from_node, t.to_node, t.kind, 'record'
         from unnest($1::bigint[], $2::bigint[], $3::text[]) as t(from_node, to_node, kind)
         on conflict (from_node, to_node, kind) do nothing`,
        [part.map((x) => x.from), part.map((x) => x.to), part.map((x) => x.kind)],
      );
    }

    // 取り込みで消えた要素は墓標を立てる。id は再利用しない契約なので、消さずに残す。
    // **空の配列では何もしない。**要素ゼロの IR を投げるだけで、その記録の node を
    // 全部 soft delete できてしまう（NOT IN 空集合は真になる）。
    if (nodes.length > 0) {
      await client.query(
        `update node set deleted_at=now() where record_id=$1 and deleted_at is null
         and (kind, key) not in (select * from unnest($2::text[], $3::text[]))`,
        [ir.meta.id, nodes.map((n) => n.kind), nodes.map((n) => n.key)],
      );
    }

    await client.query("commit");
    return {
      nodes: nodes.length,
      embedded: need.length,
      scopeId: effectiveScope,
      keptScope: existingScope !== undefined && existingScope !== scopeId ? existingScope : null,
    };
  } catch (e) {
    // rollback 自体が投げると本来の原因が失われる。外部 API を begin の中で呼ぶ以上、
    // 「Voyage が 429 かつ接続断」は現実に起きる組み合わせ。
    try {
      await client.query("rollback");
    } catch {
      /* 本来の例外を優先する */
    }
    throw e;
  }
}
