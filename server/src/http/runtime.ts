import { lazyPool, loadEnv } from "../db.ts";

export const env = loadEnv();

// 画面の API は読むだけ。同時に来る読み込みを 1 本へ積まないよう pool を使う。
export const db = lazyPool(env, "reader");
