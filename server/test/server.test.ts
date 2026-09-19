// 画面の API に認証が無くなった代わりの境界を、実際に HTTP を喋って確かめる。
// **fetch では Host を偽装できない**（forbidden header name）ので node:http で生の要求を組む。

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { allowedHosts, createApp } from "../src/server.ts";

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function ask(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/** Host を持たない要求。HTTP/1.1 は Host 必須なので 1.0 で喋る（http.request では空にできない）。 */
function withoutHost(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(text.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
      Number.isFinite(status)
        ? resolve(status)
        : reject(new Error(`status を読めない: ${text.slice(0, 80)}`));
    });
  });
}

/** 空いている port を 1 つ借りる。Host の検査が port を含むので、0 番のまま起動できない。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) return reject(new Error("port を取れない"));
      probe.close(() => resolve(address.port));
    });
  });
}

let port = 0;
let server: ReturnType<typeof serve>;

before(async () => {
  port = await freePort();
  server = serve({ fetch: createApp(port).fetch, port, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
});

after(() => {
  server?.close();
});

// 同じ LAN の別マシンから届かないことの根拠は bind そのもの。
test("listener は 127.0.0.1 にだけ着く", () => {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.port, port);
});

// 127.0.0.1 へ bind するだけでは DNS rebinding を塞げない。
// 攻撃者のドメインが 127.0.0.1 を返した瞬間、ブラウザから見て同一 origin になる。
test("Host が手元の綴りでなければ、画面も API も 403", async () => {
  for (const path of ["/", "/index.html", "/api/__probe__"]) {
    for (const host of ["evil.example.com", `evil.example.com:${port}`, `localhost:${port + 1}`]) {
      const reply = await ask(port, path, { headers: { host } });
      assert.equal(reply.status, 403, `${path} に Host: ${host}`);
    }
  }
});

test("Host が無ければ 403", async () => {
  assert.equal(await withoutHost(port, "/api/__probe__"), 403);
  assert.equal(await withoutHost(port, "/"), 403);
});

test("手元の綴りなら、その先へ通す", async () => {
  for (const host of allowedHosts(port)) {
    const reply = await ask(port, "/api/__probe__", { headers: { host } });
    assert.notEqual(reply.status, 403, host);
  }
});

// multipart は CORS の simple request なので preflight を経ずに届く。
// 文字起こしは音声の長さぶん課金されるので、ここが他所のページからの踏み台になる。
test("他所のページからの multipart は 403、同じ origin なら通す", async () => {
  const multipart = {
    host: `127.0.0.1:${port}`,
    "content-type": "multipart/form-data; boundary=x",
    "sec-fetch-site": "cross-site",
    origin: "https://evil.example.com",
  };
  const blocked = await ask(port, "/api/__probe__", {
    method: "POST",
    headers: multipart,
    body: "--x--\r\n",
  });
  assert.equal(blocked.status, 403);

  const same = await ask(port, "/api/__probe__", {
    method: "POST",
    headers: { ...multipart, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
    body: "--x--\r\n",
  });
  assert.notEqual(same.status, 403);
});

// 許可を返さないことが、cross-origin の読み取りを止める手段そのもの。
test("cross-origin の問い合わせに CORS の許可を返さない", async () => {
  const reply = await ask(port, "/api/__probe__", {
    method: "OPTIONS",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(reply.headers["access-control-allow-origin"], undefined);
  assert.equal(reply.headers["access-control-allow-credentials"], undefined);
});

// 実在する route が middleware より後に登録されると、そこだけ境界の外に出る。
// **Host が合わなければ handler へ入らない**ので、この検査は DB にも外部 API にも触らない。
test("実在する API も残らず境界の内側にある", async () => {
  const routes = [
    "/api/chat",
    "/api/polish",
    "/api/projects",
    "/api/read",
    "/api/realtime-token",
    "/api/reply",
    "/api/sessions",
    "/api/sessions/search",
    "/api/transcribe",
  ];
  for (const path of routes) {
    const reply = await ask(port, path, { headers: { host: "evil.example.com" } });
    assert.equal(reply.status, 403, path);
  }
});

// 別の番号へ黙って移ると、Host の検査と食い違って画面が 403 になる。
test("port が塞がっていたら別の番号へ移らない", async () => {
  const taken = await freePort();
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(taken, "127.0.0.1", r));
  try {
    const second = serve({ fetch: createApp(taken).fetch, port: taken, hostname: "127.0.0.1" });
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => second.once("error", resolve));
    assert.equal(error.code, "EADDRINUSE");
    second.close();
  } finally {
    blocker.close();
  }
});
