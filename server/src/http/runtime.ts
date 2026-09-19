import { type Env, KEY, lazyPool, loadEnv } from "../db.ts";

/**
 * 画面の API が使う変数だけを載せる。**owner / ingest / capture の鍵をこのプロセスへ持ち込まない。**
 *
 * ここは取り込んだ PR の本文と記録した会話を読む出口で、どちらも untrusted な文章である
 * （`AGENTS.md` の実行境界）。書き込みの鍵が同じプロセスに在ると、読んだ文章に書かされる経路が
 * 「今の route が使っていない」だけの理由で閉じていることになる。能力として持たせない。
 *
 * **足すときは、HTTP から到達する経路が実際に読む変数だけにする。**
 * 絞りすぎると黙って壊れる（`GLEANERY_CHAT_EFFORT` が抜けていて、会議の返答案だけが既定値に戻った）。
 */
const USED = [KEY.reader, "VOYAGE_API_KEY", "OPENAI_API_KEY", "GLEANERY_CHAT_MODEL", "GLEANERY_CHAT_EFFORT"];

const all = loadEnv();
export const env: Env = Object.fromEntries(USED.map((name) => [name, all[name]]));

// 画面の API は読むだけ。同時に来る読み込みを 1 本へ積まないよう pool を使う。
export const db = lazyPool(env, "reader");
