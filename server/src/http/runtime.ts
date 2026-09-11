import type pg from "pg";
import { loadEnv, pool } from "../db.ts";

export const env = loadEnv(process.cwd());

// Concurrent dashboard reads need a pool; a single client would serialize every request.
let readPool: pg.Pool | null = null;
export function db(): pg.Pool {
  readPool ??= pool(env, { as: "read" });
  return readPool;
}

let configPool: pg.Pool | null = null;
export function cfg(): pg.Pool {
  // This role can change dashboard configuration but cannot write the knowledge tables.
  configPool ??= pool(env, { as: "config" });
  return configPool;
}
