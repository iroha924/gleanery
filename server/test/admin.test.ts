import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { needsRoleKeys } from "../src/admin.ts";
import { type Env, KEY } from "../src/db.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

const KEYS: Env = {
  [KEY.reader]: "postgres://gleanery_reader:old@127.0.0.1:5432/gleanery",
  [KEY.ingest]: "postgres://gleanery_ingest:old@127.0.0.1:5432/gleanery",
  [KEY.capture]: "postgres://gleanery_capture:old@127.0.0.1:5432/gleanery",
};

// `docker compose down -v` で作り直した DB のロールはパスワードを持たない（db/schema.sql の create role）。
// 前の DB の鍵を env に残したままだと、db init は成功したまま 3 つの出口とも認証に落ちる。
test("schema を当てた直後は、env に 3 鍵が揃っていてもロールの鍵を作り直す", () => {
  assert.equal(needsRoleKeys(true, KEYS), true);
  assert.equal(needsRoleKeys(false, KEYS), false);
  for (const role of ["reader", "ingest", "capture"] as const) {
    assert.equal(needsRoleKeys(false, { ...KEYS, [KEY[role]]: undefined }), true, role);
    assert.equal(needsRoleKeys(true, { ...KEYS, [KEY[role]]: undefined }), true, role);
  }
});

/**
 * owner の鍵だけを置いた temp HOME と、docker を騙る shim だけの PATH で CLI を走らせる。
 * shim は呼ばれた引数を書き出すので、docker まで届いたかどうかを実際に見分けられる。
 */
function run(url: string, ...args: string[]): { code: number; out: string; docker: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-admin-"));
  const log = path.join(dir, "docker.log");
  try {
    fs.mkdirSync(path.join(dir, ".gleanery"));
    fs.writeFileSync(path.join(dir, ".gleanery", "env"), `${KEY.owner}=${url}\n`, { mode: 0o600 });
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, {
      mode: 0o755,
    });
    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: bin, HOME: dir, GLEANERY_ENV_DIR: "/nonexistent" },
        // 終わらない退行で試験ごと止まらないようにする（同期の呼び出しには --test-timeout が効かない）。
        timeout: 30_000,
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; code?: string };
      if (err.code === "ETIMEDOUT") throw new Error(`gleanery ${args.join(" ")} が 30 秒で終わらなかった`);
      code = err.status ?? -1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { code, out, docker: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// compose はこの PC のコンテナを起動するが、その後の schema とロールのパスワードは URL の host へ当たる。
// 綴りの違う host を loopback と認めると、手元の DB を初期化したつもりで外の DB を書き換える。
test("owner の接続先が loopback でなければ、db init / up / down は docker を起動せずに止まる", () => {
  for (const host of ["db.example.com", "127.0.0.2", "127.1", "0x7f.1", "localhost.example.com"]) {
    for (const cmd of ["init", "up", "down"]) {
      const r = run(`postgres://postgres:pw@${host}:5432/gleanery`, "db", cmd);
      assert.notEqual(r.code, 0, `db ${cmd} ${host}: ${r.out}`);
      assert.match(r.out, /この PC の DB でない/, `db ${cmd} ${host}: ${r.out}`);
      assert.equal(r.docker, "", `db ${cmd} ${host} が docker を呼んだ: ${r.docker}`);
    }
  }
});

// 上の試験が、別の理由で止まっているだけにならないようにする。
test("owner の接続先が loopback なら docker まで届く", () => {
  const r = run("postgres://postgres:pw@127.0.0.1:55432/gleanery", "db", "down");
  assert.equal(r.code, 0, r.out);
  assert.match(r.docker, /^compose .*\bdown$/m, r.docker);
});

// migrate は docker を触らない。他所の DB へ当てる用途がありうるので loopback に縛らない。
// 接続先は、名前を引かずに即座に断られて、loopback の綴りでもないものにする。
test("db migrate は loopback でない接続先でも接続まで進む", () => {
  const r = run("postgres://postgres:pw@0.0.0.0:1/gleanery", "db", "migrate", "--yes");
  assert.notEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /この PC の DB でない/, r.out);
  assert.equal(r.docker, "", `migrate が docker を呼んだ: ${r.docker}`);
});
