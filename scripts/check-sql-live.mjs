#!/usr/bin/env node
// 配る entrypoint を実 PostgreSQL に対して走らせ、SQL とロールと接続をまとめて確かめる。
//
// `sql:parse` は kysely が組み立てた SQL を EXPLAIN に通すだけで、db を引数で受ける関数しか届かない。
// CLI は open(env, role) を自分で呼び、画面の route は http/runtime.ts の module 束縛の db を使うので、
// 偽の db を差し込む継ぎ目が無い。継ぎ目を作るより、実際に起動するほうが見えるものが多い ——
// fake は書き込み SQL も受け付けるが、reader で繋いだ実 DB は権限で止める。
//
// 例外の条件は .claude/rules/verification.md「実 DB へ繋ぐのは専用の検査レーンだけ」にある。

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { fakeGh, makeRepo, runCli, runHook, withServer, withTempDir, writeEnv } from "./lib/live-harness.mjs";
import { ALLOWED_UNREACHED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";
import { roleUrls, root, withTempPostgres } from "./lib/temp-postgres.mjs";

/** 空いている port を 1 つ取る。開発用の画面が 4924 を使っているので固定にできない。 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const failures = [];
const note = (what, r) => {
  if (r.timedOut) failures.push(`${what}: 時間切れで殺した`);
  else if (r.status !== 0) failures.push(`${what}: exit ${r.status}\n${r.out.trim().slice(0, 600)}`);
  return r;
};

await withTempDir(async (dir) => {
  const covDir = path.join(dir, "coverage");
  fs.mkdirSync(covDir, { recursive: true });
  const repo = makeRepo(dir);
  fakeGh(dir);

  await withTempPostgres("sql-live", async ({ name, port: dbPort }) => {
    writeEnv(dir, roleUrls(name, dbPort));

    // ---- CLI。作る → 取り込む → 引く → 消す、の順で通す ----
    // remote があるので --name は付けない（付けると CLI が止める）。key は git:github.com/example/live になる。
    note("project add", runCli(["project", "add", "--cwd", repo], dir, covDir));
    note("project list", runCli(["project", "list"], dir, covDir));
    // **harvest はここでは半分だけ通る。**作業場所の key は remote の綴りから決まるので、
    // github の URL を持たせると文書の同期が本物の remote を引きに行き、手元では届かない
    // （insteadOf で手元へ読み替えると `git remote get-url` もそちらを返し、key が github でなくなる）。
    // 無視せず、GitHub 側が通って文書側だけが落ちることを綴りで確かめる。
    const harvest = runCli(["harvest", "--cwd", repo], dir, covDir);
    if (!/GitHub: /.test(harvest.out))
      failures.push(`harvest の GitHub 側が動いていない\n${harvest.out.slice(0, 600)}`);
    if (!/remote の既定 branch を取れなかった/.test(harvest.out)) {
      failures.push(
        `harvest の文書側が、手元では届かないはずの remote を引けている\n${harvest.out.slice(0, 600)}`,
      );
    }
    // 2 巡目。前より発言が減るので、消えた発言を消す枝がここで通る。
    const again = runCli(["harvest", "--cwd", repo], dir, covDir, { GLEANERY_FAKE_GH_ROUND: "2" });
    if (!/GitHub: /.test(again.out))
      failures.push(`2 巡目の harvest が GitHub を回していない\n${again.out.slice(0, 400)}`);

    note("who（名簿）", runCli(["who"], dir, covDir));
    note("who（結ぶ）", runCli(["who", "--me", "私", "someone"], dir, covDir));

    // trace の command は cwd の作業場所へ書き、記録の session がいまのホストの session と一致することを要る。
    const asSession = (id) => ({ cwd: repo, CLAUDE_CODE_SESSION_ID: id });
    const trace = path.join(dir, "trace.json");
    fs.writeFileSync(
      trace,
      JSON.stringify({
        schema: "trace/1",
        session: { host: "claude-code", id: "live-1" },
        work: { key: "w-1", title: "検査", goal: "SQL を通す", current: "通している", status: "active" },
        items: [
          {
            key: "d-1",
            kind: "decision",
            status: "accepted",
            at: "2026-09-13T10:00:00+09:00",
            text: "実 DB で通す",
            context: "偽の db では権限が見えない",
            options: [
              { text: "実 DB", chosen: true },
              { text: "偽の db", chosen: false, why: "書き込みも受け付ける" },
            ],
            confirmation: "この検査が緑であること",
          },
        ],
      }),
    );
    note("trace check", runCli(["trace", "check", trace], dir, covDir, { cwd: repo }));
    // context は記録を書く前に、その session の発言と既存の判断を読む。読む側の SQL はここだけが通る。
    note("trace context", runCli(["trace", "context"], dir, covDir, asSession("live-1")));
    note("trace save", runCli(["trace", "save", trace], dir, covDir, asSession("live-1")));
    // 集合を受ける枝は空でも通す。空配列を in へ渡して `in ()` になった欠陥がこの形だった。
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(
      empty,
      JSON.stringify({ schema: "trace/1", session: { host: "claude-code", id: "live-2" }, items: [] }),
    );
    note("trace save（items が空）", runCli(["trace", "save", empty], dir, covDir, asSession("live-2")));

    note("search", runCli(["search", "--cwd", repo, "実", "DB"], dir, covDir));
    note("search --avoid", runCli(["search", "--avoid", "--cwd", repo, "偽"], dir, covDir));
    note("search --said", runCli(["search", "--said", "me", "--cwd", repo, "実"], dir, covDir));
    // 自動記録。フックで待ち行列へ積んでから送る。積まずに送ると 0 件で戻り、書き込みの SQL が出ない。
    const turn = { session_id: "live-1", prompt_id: "p1", cwd: repo };
    const hook = (extra) => runHook({ ...turn, ...extra }, dir, covDir, asSession("live-1"));
    hook({ hook_event_name: "UserPromptSubmit", prompt: "実 DB で SQL を通す" });
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${repo}/docs/design.md` },
    });
    hook({ hook_event_name: "Stop", last_assistant_message: "通した。" });
    note("capture flush", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));
    // doctor は外部サービスの鍵が無いと 1 で終わる。ここでは渡さないのが正しいので、終了コードでは
    // なく中身を見る。3 つのロールが繋がって schema の版が合うことは、この行だけが確かめている。
    const doctor = runCli(["doctor"], dir, covDir);
    for (const key of ["GLEANERY_DB_URL_RO", "GLEANERY_DB_URL_INGEST", "GLEANERY_DB_URL_CAPTURE"]) {
      if (!new RegExp(`✓ ${key}\\s+繋がる / schema は期待どおり`).test(doctor.out)) {
        failures.push(`doctor が ${key} を健全と言わない\n${doctor.out.slice(0, 800)}`);
      }
    }
    // 鍵を渡していないことは指摘されるはず。件数では数えない —— plugin の版や導入の状態は
    // 手元の事情で変わり（npm へ入れた CLI と作業ツリーの中身が違う等）、この検査と関係なく増える。
    if (!/VOYAGE_API_KEY/.test(doctor.out)) {
      failures.push(
        `doctor が VOYAGE_API_KEY の不在を指摘しない。鍵が漏れている\n${doctor.out.slice(0, 800)}`,
      );
    }

    // ---- 画面の API。reader だけを持つ子プロセスで起動する ----
    const httpPort = await freePort();
    await withServer(dir, covDir, httpPort, async (base, log) => {
      const host = `127.0.0.1:${httpPort}`;
      const ids = { session: null, knowledge: null };
      const get = async (route) => {
        const res = await fetch(`${base}${route}`, { headers: { host } });
        const body = await res.text();
        if (!res.ok) failures.push(`GET ${route}: ${res.status}\n${body.slice(0, 400)}`);
        return { status: res.status, body };
      };
      // 応答が JSON とは限らない。落ちた route は本文に Internal Server Error を返すので、
      // そのまま JSON.parse すると検査自身が例外で落ちて、何が壊れたか出ないまま終わる。
      const asJson = (route, body, fallback) => {
        try {
          return JSON.parse(body || "null") ?? fallback;
        } catch {
          failures.push(`GET ${route} が JSON を返さなかった: ${body.slice(0, 200)}`);
          return fallback;
        }
      };
      const projects = await get("/api/projects");
      const projectId = asJson("/api/projects", projects.body, [])[0]?.id;
      const sessions = await get(`/api/sessions?project=${projectId ?? 1}`);
      ids.session = asJson("/api/sessions", sessions.body, {}).items?.[0]?.id ?? null;
      await get(
        `/api/sessions/search?q=${encodeURIComponent("実 DB")}&mode=knowledge&project=${projectId ?? 1}`,
      );
      await get(`/api/sessions/search?q=${encodeURIComponent("偽")}&mode=avoid&project=${projectId ?? 1}`);
      await get(`/api/sessions/search?q=${encodeURIComponent("実")}&mode=said&project=${projectId ?? 1}`);
      if (ids.session) await get(`/api/sessions/${ids.session}`);
      else failures.push("session が 1 件も返らず、/api/sessions/:id へ到達できない");
      await get(`/api/read?ref=k:1&projects=${projectId ?? 1}`);
      // 書き込みの出口を持たないことを、権限の側からも見る。
      const post = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { host, origin: `http://${host}`, "content-type": "application/json" },
        body: "{}",
      });
      if (post.status < 400)
        failures.push(`POST /api/projects が ${post.status} を返した。読むだけの出口である`);
      if (/error|Error/.test(log())) failures.push(`画面の API がエラーを出した:\n${log().slice(0, 600)}`);
    });

    note(
      "project forget",
      runCli(["project", "forget", "git:github.com/example/live", "--yes"], dir, covDir),
    );
  });

  // ---- 到達を数える ----
  const sites = callSites(root).filter((s) => LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
  const covered = coveredSites(covDir, root, sites);
  const missed = sites.filter((s) => !covered.has(s));

  if (missed.length) {
    const allowed = new Set(ALLOWED_UNREACHED.map((a) => a.site));
    const unexpected = missed.filter((s) => !allowed.has(s));
    if (unexpected.length) {
      failures.push(
        `実 DB でも踏んでいない SQL がある。\n    ${unexpected.join("\n    ")}\n` +
          "  到達させられないなら scripts/lib/sql-call-sites.mjs の ALLOWED_UNREACHED へ理由付きで足す。",
      );
    }
  }
  for (const a of ALLOWED_UNREACHED) {
    if (covered.has(a.site)) failures.push(`${a.site}: 踏むようになった。ALLOWED_UNREACHED から外す`);
  }

  if (failures.length) {
    console.error(`実 DB のレーンで ${failures.length} 件落ちた。\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(
    `実 DB: CLI と画面の API を子プロセスで走らせ、${covered.size} / ${sites.length} 箇所の SQL を通した`,
  );
});
