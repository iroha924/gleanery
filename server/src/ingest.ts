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
    issues?: { key?: string; url?: string; title?: string; state?: string; fetched?: string }[];
    prs?: { number: number; title?: string; state?: string; url?: string }[];
    commits?: { sha: string; subject?: string }[];
    files?: string[];
  };
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
  return "na";
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
        subkind: o.chosen ? "chosen" : "rejected",
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

    const idOf = new Map<string, number>();
    for (const n of nodes) {
      const v = byKey.get(`${n.kind}|${n.key}`);
      const r = await client.query<{ id: number }>(
        `insert into node (record_id, scope_id, kind, key, ordinal, at, text, subkind, status,
                           polarity, confidence, attrs, content_hash, embed_text, embed_model, embedded_at, embedding)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (record_id, kind, key) do update set
           scope_id=excluded.scope_id, ordinal=excluded.ordinal, at=excluded.at, text=excluded.text, subkind=excluded.subkind,
           status=excluded.status, polarity=excluded.polarity, confidence=excluded.confidence,
           attrs=excluded.attrs, content_hash=excluded.content_hash, deleted_at=null,
           embed_text=coalesce(excluded.embed_text, node.embed_text),
           embed_model=coalesce(excluded.embed_model, node.embed_model),
           embedded_at=coalesce(excluded.embedded_at, node.embedded_at),
           embedding=coalesce(excluded.embedding, node.embedding)
         returning id`,
        [
          ir.meta.id,
          effectiveScope,
          n.kind,
          n.key,
          n.ordinal ?? 0,
          n.at ?? null,
          n.text,
          n.subkind ?? null,
          n.status ?? null,
          n.polarity,
          n.confidence ?? null,
          JSON.stringify(n.attrs ?? {}),
          n.contentHash,
          v ? embedText(ir, n) : null,
          v ? EMBED_MODEL : null,
          v ? new Date().toISOString() : null,
          vec(v),
        ],
      );
      const id = r.rows[0]?.id;
      if (id === undefined) throw new Error(`node の upsert が id を返さなかった: ${n.kind}|${n.key}`);
      idOf.set(`${n.kind}|${n.key}`, id);
    }

    // 外部の実体（issue / PR / commit / file / url）を登録して node へ結ぶ。
    // ここが埋まらないと、パスの完全一致で「このファイルは触らないと決めた」を引けない。
    const putRef = async (
      kind: string,
      key: string | null | undefined,
      extra: { repo?: string; title?: string; state?: string; url?: string; fetched?: string } = {},
    ): Promise<number | null> => {
      if (!key) return null;
      const r = await client.query<{ id: number }>(
        `insert into ref (kind, repo, key, title, state, url, fetched)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (kind, coalesce(repo,''), key) do update set
           title=coalesce(excluded.title, ref.title), state=coalesce(excluded.state, ref.state),
           url=coalesce(excluded.url, ref.url), fetched=coalesce(excluded.fetched, ref.fetched)
         returning id`,
        [
          kind,
          extra.repo ?? null,
          String(key),
          extra.title ?? null,
          extra.state ?? null,
          extra.url ?? null,
          extra.fetched ?? null,
        ],
      );
      return r.rows[0]?.id ?? null;
    };
    const linkRef = async (
      refId: number | null,
      role: string,
      nodeId: number | null = null,
      note: string | null = null,
      exit: number | null = null,
    ): Promise<void> => {
      if (!refId) return;
      await client.query(
        `insert into ref_link (ref_id, record_id, node_id, role, note, exit_code)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (ref_id, record_id, role, coalesce(node_id, 0)) do nothing`,
        [refId, ir.meta.id, nodeId, role, note, exit],
      );
    };

    for (const n of nodes) {
      const nodeId = idOf.get(`${n.kind}|${n.key}`) ?? null;
      for (const e of arr(n.evidence)) {
        if (!["file", "commit", "url", "issue", "command"].includes(e.kind)) continue;
        // ファイルは行番号を落として登録する。行が違っても同じファイルとして引きたい。
        const key = e.kind === "file" ? String(e.ref).split(":")[0] : String(e.ref);
        await linkRef(await putRef(e.kind, key), "evidence", nodeId, e.note ?? null, e.exit ?? null);
      }
    }
    for (const i of arr(ir.links?.issues)) {
      await linkRef(
        await putRef("issue", i.key ?? i.url, {
          title: i.title,
          state: i.state,
          url: i.url,
          fetched: i.fetched,
        }),
        "link",
      );
    }
    for (const p of arr(ir.links?.prs)) {
      await linkRef(
        await putRef("pr", String(p.number), { title: p.title, state: p.state, url: p.url }),
        "link",
      );
    }
    for (const cm of arr(ir.links?.commits)) {
      await linkRef(await putRef("commit", cm.sha, { title: cm.subject }), "link");
    }
    for (const f of arr(ir.links?.files)) {
      await linkRef(await putRef("file", String(f).split(":")[0]), "touched");
    }

    // 親子（option → decision）
    for (const n of nodes) {
      if (!n.parentKey) continue;
      await client.query("update node set parent_id=$1 where id=$2", [
        idOf.get(`decision|${n.parentKey}`) ?? null,
        idOf.get(`${n.kind}|${n.key}`),
      ]);
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
