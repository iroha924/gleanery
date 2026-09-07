#!/usr/bin/env node
// ダッシュボードが叩く読み取り API。
//
// **資格情報はブラウザへ出さない。**DB と Voyage を触るのはここだけで、
// 画面は HTTP しか知らない。接続は読み取り専用ロールで張る（書き込み経路を作らない）。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import type pg from "pg";
import { type ChatBody, chat, type Learn } from "./chat.ts";
import { connect, loadEnv } from "./db.ts";
import { candidates, identify } from "./scope.ts";
import { labelOf, type Polarity, scopeFamily, search } from "./search.ts";

const env = loadEnv(process.cwd());
let pending: Promise<pg.Client> | null = null;
function db(): Promise<pg.Client> {
  if (pending) return pending;
  const p = connect(env, { as: "read" }).then((c) => {
    c.on("error", () => {
      if (pending === p) pending = null;
      c.end().catch(() => {});
    });
    return c;
  });
  p.catch(() => {
    if (pending === p) pending = null;
  });
  pending = p;
  return p;
}

// 束ねる設定だけを書ける鍵。record / node / ref には触れないので、
// 画面が壊れてもナレッジ本体は書き換わらない。
let cfgPending: Promise<pg.Client> | null = null;
function cfg(): Promise<pg.Client> {
  if (cfgPending) return cfgPending;
  const p = connect(env, { as: "config" }).then((c) => {
    c.on("error", () => {
      if (cfgPending === p) cfgPending = null;
      c.end().catch(() => {});
    });
    return c;
  });
  p.catch(() => {
    if (cfgPending === p) cfgPending = null;
  });
  cfgPending = p;
  return p;
}

const app = new Hono();
// 開発中は Vite が別ポートで動く。読み取りしかしないので localhost に限って許す。
app.use("/api/*", cors({ origin: (o) => (/^http:\/\/localhost:\d+$/.test(o) ? o : null) }));

/**
 * 画面がいま開いているプロジェクトの範囲。
 *
 * **絞り込みは画面が決める。**「いま何を見ているのか」は 1 箇所（ヘッダの切り替え）で決まり、
 * 画面ごとに別々の範囲を持たない。指定が無いときは「すべて」なので絞らない。
 */
function scopesOf(c: { req: { query: (k: string) => string | undefined } }): number[] | null {
  const raw = c.req.query("scopes");
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0);
  // **空文字は「どれも見ない」。**未指定（null）と区別する。
  return ids;
}

// 「いま」の画面。**問いを持たずに開ける唯一の画面**にする。
// 前回どこで止まって、次に誰が何をするのか。record にあるのに画面が出していなかった。
app.get("/api/now", async (c) => {
  const client = await db();
  const r = await client.query(
    `select r.id, r.title, r.status, r.branch, r.current_at, r.current_text,
            r.phases, r.next, r.updated_at, s.label as project
     from record r join scope s on s.id = r.scope_id
     where ($1::int[] is null or r.scope_id = any($1))
       -- **現在地を持ち得ない record を混ぜない。**phases と next を書くのは trace の取り込みだけで
       -- （ingest）、GitHub 由来の record（github:<repo>）はそこを通らないので永久に空のまま出る。
       -- 取り込みを回すたびに空の殻が 1 枚増えるので、画面側ではなくここで外す。
       and r.phases is not null
       and jsonb_array_length(r.phases) > 0
     order by r.updated_at desc nulls last limit 5`,
    [scopesOf(c)],
  );
  const ids = r.rows.map((x) => x.id as string);
  // 触ってはいけないもの／やらないと決めたことは、流れの外に置く。
  const walls = ids.length
    ? await client.query(
        `select record_id, subkind, text, key from node
         where record_id = any($1) and kind = 'boundary' and deleted_at is null
         order by subkind, ordinal`,
        [ids],
      )
    : { rows: [] };
  return c.json(
    r.rows.map((x) => ({
      ...x,
      walls: walls.rows.filter((w) => w.record_id === x.id),
    })),
  );
});

// 保存した直後に人が見る画面。**機械が付けた分類を人が確かめるためのもの。**
// 直せるようにはしない — polarity は取り込みのたびに IR から計算し直されるので、
// ここで直しても次の保存で黙って戻る（ingest.ts の upsert が polarity=excluded.polarity）。
// おかしければ記録の側（/mitos:trace）を直す。
app.get("/api/scopes", async (c) => {
  const q = await (await db()).query(
    `select s.id::int, s.label, s.role, s.summary,
            coalesce(string_agg(distinct g.name, ', '), null) as groups,
            (select count(*) from record where scope_id = s.id)::int as records,
            (select count(*) from node where scope_id = s.id and deleted_at is null)::int as nodes
     from scope s
     left join group_member m on m.scope_id = s.id
     left join scope_group  g on g.id = m.group_id
     group by s.id order by s.label`,
  );
  return c.json(q.rows);
});

app.get("/api/records", async (c) => {
  const q = await (await db()).query(
    `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
            r.updated_at, s.label as scope_label,
            (select count(*) from node where record_id = r.id and deleted_at is null)::int as nodes
     from record r join scope s on s.id = r.scope_id
     where ($1::int[] is null or r.scope_id = any($1))
     order by r.updated_at desc nulls last`,
    [scopesOf(c)],
  );
  return c.json(q.rows);
});

app.get("/api/records/:id", async (c) => {
  const client = await db();
  // **列を並べる。`r.*` にしない。**IR 全文（101 KB）と 1024 次元のベクトル（12 KB）が
  // 詳細を開くたびに流れていた（実測: 166 KB のうち 114 KB が画面の使わない 2 列）。
  const rec = await client.query(
    `select r.id, r.title, r.status, r.branch, r.problem, r.goal, r.current_at, r.current_text,
            r.phases, r.next, r.created_at, r.updated_at, r.ended_at, r.ingested_at,
            s.label as scope_label
     from record r join scope s on s.id = r.scope_id where r.id = $1`,
    [c.req.param("id")],
  );
  if (rec.rows.length === 0) return c.json({ error: "その記録は無い" }, 404);
  const nodes = await client.query(
    `select id::int, kind, subkind, polarity, status, key, at, text,
            coalesce(attrs->>'whyNot', attrs->>'context', '') as ex, attrs, parent_id::int
     from node where record_id = $1 and deleted_at is null
     order by kind, ordinal, at nulls last`,
    [c.req.param("id")],
  );
  // 同じファイルが「根拠」と「触った」の両方に出ると、distinct でも 2 行残る。
  // 役割をまとめて 1 行にする（画面のキーが重複していた。実測 7 件）。
  const refs = await client.query(
    `select ref.kind, ref.key, min(ref.title) as title, min(ref.url) as url,
            string_agg(distinct l.role, ',' order by l.role) as roles,
            count(*) filter (where l.exit_code is not null and l.exit_code <> 0)::int as failed
     from ref join ref_link l on l.ref_id = ref.id
     where l.record_id = $1
     group by ref.kind, ref.key
     order by ref.kind, ref.key`,
    [c.req.param("id")],
  );
  return c.json({
    ...rec.rows[0],
    nodes: nodes.rows.map((n) => ({ ...n, label: labelOf(n) })),
    refs: refs.rows,
  });
});

app.post("/api/search", async (c) => {
  const body = (await c.req.json()) as {
    question?: string;
    onlyDont?: boolean;
    kinds?: string[];
    scopeIds?: number[];
    limit?: number;
  };
  const question = (body.question ?? "").trim();
  if (!question) return c.json({ error: "質問が空" }, 400);
  const limit = Math.min(Math.max(Number(body.limit ?? 10), 1), 20);

  const client = await db();
  // 範囲はヘッダで選んだものが来る。**未指定は「すべて」**（絞らない）。
  const scopeIds = Array.isArray(body.scopeIds) ? body.scopeIds : undefined;
  const polarity: Polarity | undefined = body.onlyDont ? "dont" : undefined;
  const { rows } = await search(client, env, { question, scopeIds, polarity, kinds: body.kinds, limit });
  // **id は数で返す。**pg は bigint を文字列で返すので、そのままだと画面側の数と一致しない。
  return c.json(rows.map((r) => ({ ...r, id: Number(r.id), label: labelOf(r) })));
});

// 束ねる候補。~/Projects 配下と、実際に作業した場所（transcript から拾う）の和。
app.get("/api/candidates", async (c) => {
  const client = await db();
  const known = await client.query<{ ident: string; id: number }>("select ident, id::int as id from scope");
  const byIdent = new Map(known.rows.map((r) => [r.ident, r.id]));
  return c.json(
    candidates().map((x) => ({
      ident: x.ident,
      label: x.label,
      absPath: x.absPath,
      hostOrg: x.hostOrg,
      markers: x.markers,
      scopeId: byIdent.get(x.ident) ?? null,
    })),
  );
});

app.get("/api/groups", async (c) => {
  const r = await (await db()).query(
    `select g.id::int, g.name,
            coalesce(json_agg(json_build_object('id', s.id::int, 'label', s.label,
                              'identKind', s.ident_kind, 'ident', s.ident)
                     order by s.label) filter (where s.id is not null), '[]') as members
     from scope_group g
     left join group_member m on m.group_id = g.id
     left join scope s on s.id = m.scope_id
     group by g.id, g.name order by g.name`,
  );
  return c.json(r.rows);
});

// **束ねるのは人間が選ぶ。**推論で束ねない（org も親ディレクトリも実データで外れた）。
// 受けるのは絶対パス。ident の組み立ては CLI と同じ identify() に任せる。
app.post("/api/groups", async (c) => {
  const body = (await c.req.json()) as { name?: string; paths?: string[] };
  const name = (body.name ?? "").trim();
  const paths = Array.isArray(body.paths) ? body.paths.filter((x) => typeof x === "string" && x) : [];
  if (!name) return c.json({ error: "束の名前が空" }, 400);
  if (paths.length < 2) return c.json({ error: "2 つ以上選ぶ" }, 400);

  const client = await cfg();
  await client.query("begin");
  try {
    // **on conflict do update を使わない。**UPDATE 権限を要求するので、
    // 束ねる以外は書けない鍵では通らない（実測: permission denied）。
    const ins = await client.query<{ id: number }>(
      "insert into scope_group (name) values ($1) on conflict (name) do nothing returning id::int as id",
      [name],
    );
    const groupId =
      ins.rows[0]?.id ??
      (await client.query<{ id: number }>("select id::int as id from scope_group where name = $1", [name]))
        .rows[0]?.id;
    if (groupId === undefined) throw new Error("束を作れなかった");

    // 選び直しは「選ばれたものが全部」。外したものは束から出る。
    await client.query("delete from group_member where group_id = $1", [groupId]);
    for (const dir of paths) {
      const me = identify(dir);
      const found = await client.query<{ id: number }>("select id::int as id from scope where ident = $1", [
        me.ident,
      ]);
      let id = found.rows[0]?.id;
      if (id === undefined) {
        const created = await client.query<{ id: number }>(
          `insert into scope (ident, ident_kind, abs_path, host_org, repo_name, label)
           values ($1,$2,$3,$4,$5,$6) returning id::int as id`,
          [me.ident, me.identKind, me.absPath, me.hostOrg, me.repoName, me.label],
        );
        id = created.rows[0]?.id;
      }
      if (id !== undefined) {
        await client.query(
          "insert into group_member (group_id, scope_id) values ($1,$2) on conflict do nothing",
          [groupId, id],
        );
      }
    }
    await client.query("commit");
    return c.json({ ok: true, groupId, members: paths.length });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// --- 用語集 ---
//
// **推測で埋めない。**社内語は人に聞くしかないので、AI が答えられなかった語を
// meaning が null の行として積み、人が答えたら埋まる。
app.get("/api/terms", async (c) => {
  const ids = scopesOf(c);
  const r = await (await db()).query(
    `select t.id::int, t.word, t.aliases, t.meaning, t.asked_why, t.asked_at, g.name as project
     from term t left join scope_group g on g.id = t.group_id
     where $1::int[] is null or t.group_id is null or t.group_id in (
       select m.group_id from group_member m where m.scope_id = any($1))
     order by (t.meaning is null) desc, t.asked_at desc nulls last, t.word`,
    [ids],
  );
  return c.json(r.rows);
});

app.post("/api/terms", async (c) => {
  const body = (await c.req.json()) as {
    word?: string;
    meaning?: string;
    aliases?: string[];
    groupId?: number;
  };
  const word = (body.word ?? "").trim();
  if (!word) return c.json({ error: "言葉が空" }, 400);
  try {
    await (await cfg()).query(
      `insert into term (group_id, word, meaning, aliases) values ($1,$2,$3,$4)
       on conflict (coalesce(group_id, 0), word) do update set
         meaning = coalesce(excluded.meaning, term.meaning),
         aliases = excluded.aliases, updated_at = now()`,
      [body.groupId ?? null, word, body.meaning?.trim() || null, body.aliases ?? []],
    );
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/terms/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正" }, 400);
  try {
    await (await cfg()).query("delete from term where id = $1", [id]);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/groups/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正" }, 400);
  const client = await cfg();
  await client.query("begin");
  try {
    await client.query("delete from group_member where group_id = $1", [id]);
    await client.query("delete from scope_group where id = $1", [id]);
    await client.query("commit");
    return c.json({ ok: true });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ナレッジに基づいて答える。根拠を先に流し、それから本文を少しずつ返す。
// --- チャットの履歴 ---
//
// **ナレッジとは別の表に置く。**生成した答えを record / node へ書き戻すと、
// 誤りが「記録」に化けて次の答えがそれを引用する（自分の出力を自分の根拠にする輪）。
app.get("/api/chats", async (c) => {
  const r = await (await db()).query(
    `select c.id, c.title, c.scope_name, c.updated_at,
            (select count(*) from chat_message m where m.chat_id = c.id)::int as messages
     from chat c order by c.updated_at desc limit 100`,
  );
  return c.json(r.rows);
});

app.get("/api/chats/:id", async (c) => {
  const client = await db();
  const head = await client.query("select id, title, scope_ids, scope_name from chat where id = $1", [
    c.req.param("id"),
  ]);
  if (head.rows.length === 0) return c.json({ error: "その会話は無い" }, 404);
  const msgs = await client.query(
    "select role, content, sources, at from chat_message where chat_id = $1 order by at, id",
    [c.req.param("id")],
  );
  return c.json({ ...head.rows[0], messages: msgs.rows });
});

app.delete("/api/chats/:id", async (c) => {
  try {
    await (await cfg()).query("delete from chat where id = $1", [c.req.param("id")]);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * 音声を文字にする。**手元の whisper.cpp をやめて API にした。**同じ 50.6 秒で測ったとき、
 * 手元の最良（large-v3-turbo）が「退避させる」を「対比させる」と外したのに対し、
 * whisper-1 は誤りが 0 だった。kotoba-whisper は 20.7 秒で打ち切っていた。
 *
 * **音声はブラウザが録った形のまま送る。**変換も分割も要らない
 * （webm はそのまま受け付けるので、ffmpeg を挟むと欠ける経路が増えるだけ）。
 */
app.post("/api/transcribe", async (c) => {
  const file = (await c.req.formData()).get("audio");
  if (!(file instanceof File)) return c.json({ error: "audio が無い" }, 400);
  // API の上限。24kbps で録っているので、これに当たるのは 2 時間を超えたとき。
  if (file.size > 25_000_000) return c.json({ error: "音声が長すぎる（25MB まで）" }, 413);
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const r = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "ja",
    });
    return c.json({ text: r.text.trim() });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("transcribe:", m);
    return c.json({ error: "文字起こしに失敗した" }, 500);
  }
});

/**
 * 文字起こしを読める文へ直す候補を出す。**選ばせるためのもので、勝手には置き換えない。**
 *
 * 音声認識が外すのは 3 種類（実測）。句読点が 1 つも付かない、同音異義語を取り違える
 * （辺→変、触って→座って）、数字の桁を外す（三百十→3010）。どれも音では区別できないので
 * ASR 側では直らない。**直せるのは前後の意味を読める側だけ**なので、ここで LLM に渡す。
 */
const POLISH = `日本語の音声認識の生の出力を、読める文に直す候補を 3 つ作る。

その出力には次の癖がある。
- 句読点が 1 つも付いていない
- 同音異義語を取り違える（辺→変、触って→座って）
- 数字の桁を外す（三百十→3010）
- 言いよどみ（えー、あの）と言い直しが混ざる

3 つの候補は、直す度合いで分ける。**どれも元の意図を変えない。**
1. label「句読点だけ」… 語を一切変えず、句読点と改行だけを入れる
2. label「整えた」… 言いよどみと言い直しを取り、前後から明らかな誤変換を直す。
   **触るのはそこだけ。**誤変換でない語は 1 つも変えない（「前に」を「以前」に、
   「ダメだった」を「うまくいかなかった」に言い換えない）。言い回しを丁寧にしない
3. label「短く」… 要点だけにする。**数値・固有名詞・条件は 1 つも落とさない。**
   係り受けも変えない（「A が縮んで B が半分」を「A と B が半分」にしない）

changed には、その候補で**書き換えた後の語**だけを、本文に現れるとおりに入れる
（「ペクトル」を「ベクトル」にしたなら "ベクトル"）。句読点の追加は入れない。
語を変えていない候補は空の配列にする。

推測で情報を足さない。元に無いことを書かない。
**つなぎの意味を変えない**（「〜だったので」を「〜だったが」にしない）。
話し手の主張が事実と食い違って見えても、直すのは語であって論理ではない。`;

/**
 * 会議を聞き取るための一時鍵。**本物の API キーはブラウザへ出さない。**
 *
 * 逐次の文字起こしは Realtime を使う。20 秒ごとに切って投げる作りだと、区切りが語の途中に
 * 落ちるうえ、「聞かれている最中」に間に合わない（最大 20 秒遅れる）。Realtime は
 * サーバー側の VAD が発話の切れ目で区切るので、どちらも起きない。
 */
app.post("/api/realtime-token", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const r = await openai.realtime.clientSecrets.create({
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // **モデルは 3 つ測って決めた**（50.6 秒の日本語）。gpt-live-transcribe は VAD を
            // 受け付けず発話が確定しない（確定 0 件）。mini は誤りが 3 倍。これだけが
            // 「文字が流れながら、発話の切れ目で確定する」を満たした。
            transcription: { model: "gpt-4o-transcribe", language: "ja" },
            turn_detection: { type: "server_vad" },
            noise_reduction: { type: "near_field" },
          },
        },
      },
    });
    return c.json({ token: r.value, expiresAt: r.expires_at });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("realtime-token:", m);
    return c.json({ error: "一時鍵を作れなかった" }, 500);
  }
});

/**
 * 会議で聞かれたことへの返信案。**記録にあることしか言わない。**
 *
 * 会議中は記憶で答えてしまいがちで、後から食い違いが出る。ここは裏取りができている
 * ものだけを返し、**無いときは無いと言う**。曖昧に埋めた案は、その場では役に立っても
 * 会議のあとで訂正する羽目になるので、価値が負になる。
 */
const REPLY = `会議の相手の発言に対して、その場で返せる案を作る。

まず、それが**答えを求められている発言かどうか**を見る。相槌・世間話・自分の作業の報告なら
asked を null にして replies を空にする。**問われていないのに案を出さない。**

問われているなら、asked にその問いを一文で書く。
replies には返す言葉を 2 つか 3 つ。**渡された記録に書かれていることだけを使う。**
それぞれの sources に、根拠にした記録の番号を入れる（複数可）。

記録に答えが無いなら replies を空にして missing を true にする。
**推測で埋めない。**「たぶん」「〜のはず」で答えると、会議のあとで訂正することになる。

日本語で、会議でそのまま口に出せる長さにする（1 文か 2 文）。`;

app.post("/api/reply", async (c) => {
  const body = (await c.req.json()) as { heard?: string; scopeIds?: number[] };
  const heard = body.heard?.trim();
  if (!heard) return c.json({ error: "heard が無い" }, 400);
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

  try {
    const client = await db();
    const ids = Array.isArray(body.scopeIds) ? body.scopeIds : undefined;
    const { rows } = await search(client, env, { question: heard, scopeIds: ids, limit: 8 });
    // 番号は 1 始まり。**LLM が指す番号と画面の番号を一致させる。**
    const facts = rows.map((r, i) => `[${i + 1}] ${labelOf(r)}${r.text}${r.ex ? ` — ${r.ex}` : ""}`);

    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const r = await openai.responses.create({
      model: env.MITOS_CHAT_MODEL ?? "gpt-5.6-terra",
      // 会議の最中に出すものなので、考え込ませない。
      reasoning: { effort: "low" },
      instructions: REPLY,
      input: `相手の発言:\n${heard}\n\n記録:\n${facts.join("\n") || "(該当なし)"}`,
      text: {
        format: {
          type: "json_schema",
          name: "reply",
          strict: true,
          schema: {
            type: "object",
            properties: {
              asked: { type: ["string", "null"] },
              missing: { type: "boolean" },
              replies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    sources: { type: "array", items: { type: "integer" } },
                  },
                  required: ["text", "sources"],
                  additionalProperties: false,
                },
              },
            },
            required: ["asked", "missing", "replies"],
            additionalProperties: false,
          },
        },
      },
    });
    const out = JSON.parse(r.output_text) as {
      asked: string | null;
      missing: boolean;
      replies: { text: string; sources: number[] }[];
    };
    return c.json({
      ...out,
      // 画面が根拠を出せるように、引かれた記録も返す。
      facts: rows.map((x, i) => ({
        n: i + 1,
        label: labelOf(x),
        text: x.text,
        recordId: x.record_id,
        recordTitle: x.record_title,
      })),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("reply:", m);
    return c.json({ error: "返信案を作れなかった" }, 500);
  }
});

app.post("/api/polish", async (c) => {
  const { text } = (await c.req.json()) as { text?: string };
  if (!text?.trim()) return c.json({ error: "text が無い" }, 400);
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY が無い" }, 500);

  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const r = await openai.responses.create({
      model: env.MITOS_CHAT_MODEL ?? "gpt-5.6-terra",
      // **low では直し漏れと改悪が出る。**同じ入力を 4 回投げて全部違う結果になり、
      // 元が正しかった数字を壊すことがあった。medium は 3 回とも誤変換を直し、しかも速かった。
      reasoning: { effort: "medium" },
      instructions: POLISH,
      input: text,
      text: {
        format: {
          type: "json_schema",
          name: "polish",
          strict: true,
          schema: {
            type: "object",
            properties: {
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    text: { type: "string" },
                    changed: { type: "array", items: { type: "string" } },
                  },
                  required: ["label", "text", "changed"],
                  additionalProperties: false,
                },
              },
            },
            required: ["options"],
            additionalProperties: false,
          },
        },
      },
    });
    const parsed = JSON.parse(r.output_text) as {
      options: { label: string; text: string; changed: string[] }[];
    };
    // 元と同じものは候補にならない。
    return c.json({ options: parsed.options.filter((o) => o.text.trim() && o.text.trim() !== text.trim()) });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("polish:", m);
    return c.json({ error: "整形に失敗した" }, 500);
  }
});

app.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as ChatBody & { chatId?: string; scopeName?: string };
  const client = await db();
  // 選ばれたプロジェクトがまとめに属していれば、その相手も範囲に入れる。
  const ids = Array.isArray(body.scopeIds) ? body.scopeIds : [];
  const family = [...new Set((await Promise.all(ids.map((id) => scopeFamily(client, id)))).flat())];

  // 用語の書き込みだけ、構成用の鍵を渡す。**ナレッジ本体には触れない鍵。**
  const groupId = ids.length
    ? (
        await client.query<{ id: number }>(
          "select m.group_id::int as id from group_member m where m.scope_id = any($1) limit 1",
          [ids],
        )
      ).rows[0]?.id
    : undefined;
  const learn: Learn = async (t) => {
    const w = await cfg();
    await w.query(
      `insert into term (group_id, word, meaning, aliases, asked_why, asked_at)
       values ($1,$2,$3,$4,$5, case when $3::text is null then now() else null end)
       on conflict (coalesce(group_id, 0), word) do update set
         meaning = coalesce(excluded.meaning, term.meaning),
         aliases = case when cardinality(excluded.aliases) > 0 then excluded.aliases else term.aliases end,
         asked_why = coalesce(term.asked_why, excluded.asked_why),
         updated_at = now()`,
      [groupId ?? null, t.word, t.meaning, t.aliases, t.why],
    );
  };

  return streamSSE(c, async (stream) => {
    let answer = "";
    let sources: unknown[] = [];
    try {
      for await (const chunk of chat(client, env, { ...body, scopeIds: family, learn })) {
        if (chunk.type === "text") answer += chunk.text;
        else if (chunk.type === "sources") sources = chunk.sources;
        await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
      }
    } catch (e) {
      // 失敗も画面へ届ける。無言で止まると原因が分からない。
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: e instanceof Error ? e.message : String(e) }),
      });
    }
    // **答えが出てから残す。**途中で切れたものを履歴に積むと、読み返せない断片が増える。
    if (answer) {
      try {
        const chatId = await saveTurn(body, ids, answer, sources);
        await stream.writeSSE({ event: "saved", data: JSON.stringify({ chatId }) });
      } catch {
        // 残せなくても答えは返す
      }
    }
    await stream.writeSSE({ event: "done", data: "{}" });
  });
});

/** 1 往復を履歴へ。会話が無ければ作る。 */
async function saveTurn(
  body: ChatBody & { chatId?: string; scopeName?: string },
  ids: number[],
  answer: string,
  sources: unknown[],
): Promise<string> {
  const w = await cfg();
  let chatId = body.chatId;
  if (!chatId) {
    const r = await w.query<{ id: string }>(
      "insert into chat (title, scope_ids, scope_name) values ($1,$2,$3) returning id",
      [(body.question ?? "").slice(0, 120), ids, body.scopeName ?? null],
    );
    chatId = r.rows[0]?.id;
    if (!chatId) throw new Error("会話を作れなかった");
  } else {
    await w.query("update chat set updated_at = now() where id = $1", [chatId]);
  }
  await w.query(
    `insert into chat_message (chat_id, role, content, sources) values ($1,'user',$2,'[]'), ($1,'assistant',$3,$4)`,
    [chatId, body.question ?? "", answer, JSON.stringify(sources)],
  );
  return chatId;
}

const port = Number(process.env.MITOS_API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (i) => console.log(`mitos API: http://localhost:${i.port}`));
