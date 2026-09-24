#!/usr/bin/env node
// 配る entrypoint（CLI と自動記録のフック）を子プロセスで走らせ、一時 HOME の SQLite に対して SQL と
// 接続の役割（authorizer）と後始末をまとめて確かめる。
//
// `sql:reach` は db を引数で受ける関数を test から通す。CLI は接続を自分で開くので、test から差し込む継ぎ目が無い。
// 継ぎ目を作るより、実際に起動するほうが見えるものが多い（役割ごとの接続で、権限の外の SQL が止まる）。
//
// 子プロセスの HOME を一時ディレクトリへ向ける理由は .claude/rules/verification.md にある。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { fakeGh, makeRepo, root, runCli, runHook, withTempDir } from "./lib/live-harness.mjs";
import { ALLOWED_UNREACHED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

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

  {
    note("init", runCli(["init"], dir, covDir));

    // ---- CLI。作る → 取り込む → 引く → 消す、の順で通す ----
    // remote があるので --name は付けない（付けると CLI が止める）。key は git:github.com/example/live になる。
    note("project add", runCli(["project", "add", "--cwd", repo], dir, covDir));
    note("project list", runCli(["project", "list"], dir, covDir));
    // 文書の除外。add は connector を作り、list は join で引き、remove は副問い合わせで絞る。
    note("exclude add", runCli(["project", "exclude", "add", "--cwd", repo, "docs"], dir, covDir));
    const excluded = note("exclude list", runCli(["project", "exclude", "list", "--cwd", repo], dir, covDir));
    if (!/^\s+docs\s+directory$/m.test(excluded.out))
      failures.push(`exclude list が足した path を出していない\n${excluded.out.slice(0, 400)}`);
    note("exclude remove", runCli(["project", "exclude", "remove", "--cwd", repo, "docs"], dir, covDir));
    // **harvest はここでは半分だけ通る。**プロジェクトの key は remote の綴りから決まるので、
    // github の URL を持たせると文書の同期が本物の remote を引きに行き、手元では届かない
    // （insteadOf で手元へ読み替えると `git remote get-url` もそちらを返し、key が github でなくなる）。
    // 無視せず、GitHub 側が通って文書側だけが落ちることを綴りで確かめる。
    const harvest = runCli(["harvest", "--cwd", repo], dir, covDir);
    if (!/GitHub: /.test(harvest.out))
      failures.push(`harvest の GitHub 側が動いていない\n${harvest.out.slice(0, 600)}`);
    if (!/Could not fetch the remote's default branch/.test(harvest.out)) {
      failures.push(
        `harvest の文書側が、手元では届かないはずの remote を引けている\n${harvest.out.slice(0, 600)}`,
      );
    }
    // 2 巡目。前より発言と issue が減るので、消えた発言と消えた issue を消す枝がここで通る。
    const again = runCli(["harvest", "--cwd", repo], dir, covDir, { GLEANERY_FAKE_GH_ROUND: "2" });
    if (!/GitHub: /.test(again.out))
      failures.push(`2 巡目の harvest が GitHub を回していない\n${again.out.slice(0, 400)}`);
    if (!/PRs and issues \([^)]*1 removed\)/.test(again.out))
      failures.push(`2 巡目の harvest が消えた issue を消していない\n${again.out.slice(0, 400)}`);
    if (!/1 PRs and issues \(1 rewritten/.test(again.out) || !/\d+ messages \(0 rewritten/.test(again.out))
      failures.push(`2 巡目の harvest が題だけ変わった PR の発言を書き直した\n${again.out.slice(0, 400)}`);

    note("who（名簿）", runCli(["who"], dir, covDir));
    note("who（結ぶ）", runCli(["who", "--me", "私", "someone"], dir, covDir));

    // trace の command は cwd のプロジェクトへ書き、記録の session がいまのホストの session と一致することを要る。
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

    // 登録していないプロジェクトの記録は、捨てずに退避する（#104）。持ち主が PC を変えて project add を
    // する前に働くと、その間の発言がここへ来る。消すと二度と戻らない。
    const stranger = makeRepo(dir, "https://github.com/example/stranger.git", "stranger");
    const strangerTurn = { session_id: "live-3", prompt_id: "p9", cwd: stranger };
    const strangerAs = { cwd: stranger, CLAUDE_CODE_SESSION_ID: "live-3" };
    runHook(
      { ...strangerTurn, hook_event_name: "UserPromptSubmit", prompt: "未登録のプロジェクトでの発言" },
      dir,
      covDir,
      strangerAs,
    );
    runHook(
      { ...strangerTurn, hook_event_name: "Stop", last_assistant_message: "返した。" },
      dir,
      covDir,
      strangerAs,
    );
    const strayed = runCli(["capture", "flush"], dir, covDir, strangerAs);
    const kept = path.join(dir, ".gleanery", "spool", "unregistered");
    const left = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (left.length === 0) {
      failures.push(
        `未登録のプロジェクトの記録が ${kept} に残っていない。捨てられた可能性がある\n${strayed.out.slice(0, 400)}`,
      );
    }

    // 30 日より古い退避は刈る。上限が効かないと、登録しないまま使い続けたときに手元が埋まる。
    const stale = path.join(kept, `${Date.now() - 40 * 24 * 60 * 60 * 1000}-0-stale.json`);
    fs.writeFileSync(stale, JSON.stringify({ v: 1, kind: "message", project: "git:example/none" }));

    // プロジェクトを登録したら、退避した分がそのまま入る。ここが繋がらないと退避の意味が無い。
    note("project add（退避先）", runCli(["project", "add", "--cwd", stranger], dir, covDir));
    const retried = runCli(["capture", "flush"], dir, covDir, strangerAs);
    if (!/new messages\s+[1-9]/.test(retried.out)) {
      failures.push(`登録した後も、退避した記録が入っていない\n${retried.out.slice(0, 400)}`);
    }
    const after = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (after.length) failures.push(`送った後も退避が残っている: ${after.join(" / ")}`);
    if (fs.existsSync(stale)) failures.push(`30 日より古い退避が刈られていない: ${stale}`);
    // doctor の終了コードでは見ない —— plugin のバージョンや導入の状態は手元の事情で変わり（npm へ入れた CLI と
    // 作業ツリーの中身が違う等）、この検査と関係なく 1 になる。DB の行だけを中身で見る。
    const doctor = runCli(["doctor"], dir, covDir);
    for (const [label, want] of [
      ["Schema version", /✓ Schema version\s+revision \d+/],
      ["Full-text index", /✓ Full-text index\s+healthy/],
      ["Projects", /Projects/],
    ]) {
      if (!want.test(doctor.out))
        failures.push(`doctor が ${label} を健全と言わない\n${doctor.out.slice(0, 800)}`);
    }

    // ---- 外から来た文字の制御列を、端末へ出さない ----
    // PR・issue の本文と題、ハンドル、会話、remote の綴りとディレクトリ名は第三者か外の都合で決まる。
    // 注入した値が出力まで届いたこと（reach）を確かめてから、ESC・BEL・CR が無いことを見る（pipe では色を付けない）
    const controlled = (out) => ["\u001b", "\u0007", "\r"].some((c) => out.includes(c));
    const clean = (what, r, reach, { status = true } = {}) => {
      if (status) note(what, r);
      if (!r.out.includes(reach))
        failures.push(
          `${what} の出力に注入した値（${reach}）が届いていない。検査が空振りする\n${r.out.slice(0, 400)}`,
        );
      if (controlled(r.out))
        failures.push(`${what} の出力に制御列が残っている\n${JSON.stringify(r.out.slice(0, 400))}`);
    };
    const esc = "\u001b[2J\u001b]0;pwn\u0007\r";
    // who --me で結んだ後は、merge した持ち主の PR の本文から判断を書く（偽の gh は hostile の回だけ PR を merge 済みにする）
    const decided = runCli(["harvest", "--cwd", repo], dir, covDir, { GLEANERY_FAKE_GH_ROUND: "hostile" });
    if (!/PR decisions: [1-9]/.test(decided.out))
      failures.push(`harvest が PR の判断の結果を出していない\n${decided.out.slice(0, 600)}`);
    clean("who（第三者のハンドル）", runCli(["who"], dir, covDir), "someone");
    clean("who（結ぶ）", runCli(["who", "--me", "私", `someone${esc}`], dir, covDir), "someone");
    hook({ hook_event_name: "UserPromptSubmit", prompt: `制御列${esc}を含む発言` });
    hook({ hook_event_name: "Stop", last_assistant_message: `応答${esc}` });
    note("capture flush（制御列）", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));
    clean("trace context", runCli(["trace", "context"], dir, covDir, asSession("live-1")), "を含む発言");
    clean(
      "search --said",
      runCli(["search", "--said", "me", "--cwd", repo, "制御列"], dir, covDir),
      "を含む発言",
    );
    const evil = makeRepo(dir, `https://github.com/example/ev${esc}il.git`, "evil\u001b[2Jdir");
    clean(
      "project add（remote とディレクトリ名）",
      runCli(["project", "add", "--cwd", evil], dir, covDir),
      "evil",
    );
    clean("project list", runCli(["project", "list"], dir, covDir), "example/ev");
    clean("search（プロジェクト名）", runCli(["search", "--cwd", evil, "本文"], dir, covDir), "example/ev");
    // doctor の終了コードは手元の plugin の状態で変わるので見ない（上と同じ理由）
    clean("doctor", runCli(["doctor"], dir, covDir), "example/ev", { status: false });

    note(
      "project forget",
      runCli(["project", "forget", "git:github.com/example/live", "--yes"], dir, covDir),
    );
  }

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
  console.log(`実 DB: CLI を子プロセスで走らせ、${covered.size} / ${sites.length} 箇所の SQL を通した`);
});
