// 画面の API を、カバレッジを落とさずに止められる形で起動する入口。
//
// **SIGTERM の既定の処理は終了フックを走らせない。**NODE_V8_COVERAGE の書き出しもそこで行われるので、
// 殺すと踏んだ行が 1 つも残らない（実測: route が 200 を返したのに未到達と数えられた）。
// 本番の server.ts に停止の口を足す代わりに、検査のときだけこの入口を挟む。

import v8 from "node:v8";

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    v8.takeCoverage();
    process.exit(0);
  });
}

// server.ts は argv[1] が自分自身のときだけ起動する。入口を挟むとその判定に当たらないので、
// start() を直に呼ぶ。port は GLEANERY_DASHBOARD_PORT から取る（dev にすると番号が固定される）。
const { start } = await import(new URL("../../server/src/server.ts", import.meta.url).href);
start();
