import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import type { Turn } from "./chat";
import { type ChatEntry, deleteChat, listChats, loadChat, saveChat } from "./history";

const entry = (id: string, projectKey: string, updatedAt: string): ChatEntry => ({
  id,
  title: `題 ${id}`,
  projectKey,
  projectLabel: projectKey,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt,
});

const turns = (...contents: string[]): Turn[] =>
  contents.map((content, index) => ({
    id: `t${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content,
  }));

beforeEach(async () => {
  for (const c of await listChats()) await deleteChat(c.id);
});

test("保存した往復を、書いた順で読み出せる", async () => {
  await saveChat(entry("a", "git:x/y", "2026-09-20T01:00:00.000Z"), turns("質問", "答え", "次の質問"));
  expect((await loadChat("a")).map((t) => t.content)).toEqual(["質問", "答え", "次の質問"]);
});

// 一覧は「続きをやる」ための入口なので、新しいものが上に来ないと使えない。
test("一覧は新しいものから順に返り、作業場所で絞れる", async () => {
  await saveChat(entry("a", "git:x/y", "2026-09-20T01:00:00.000Z"), turns("あ"));
  await saveChat(entry("b", "git:x/y", "2026-09-20T03:00:00.000Z"), turns("い"));
  await saveChat(entry("c", "local:z", "2026-09-20T02:00:00.000Z"), turns("う"));
  expect((await listChats()).map((c) => c.id)).toEqual(["b", "c", "a"]);
  expect((await listChats("git:x/y")).map((c) => c.id)).toEqual(["b", "a"]);
});

// 置き換えなので、取り直した答えが前の答えと二重に残ってはいけない。
test("保存し直すと、前の往復は残らない", async () => {
  const e = entry("a", "git:x/y", "2026-09-20T01:00:00.000Z");
  await saveChat(e, turns("質問", "古い答え"));
  await saveChat(e, turns("質問", "新しい答え"));
  expect((await loadChat("a")).map((t) => t.content)).toEqual(["質問", "新しい答え"]);
});

// 消したのに往復が残ると、別の会話の id で採番し直したときに混ざる。
test("消すと、その会話の往復も残らない", async () => {
  await saveChat(entry("a", "git:x/y", "2026-09-20T01:00:00.000Z"), turns("質問", "答え"));
  await saveChat(entry("b", "git:x/y", "2026-09-20T02:00:00.000Z"), turns("別の質問"));
  await deleteChat("a");
  expect(await loadChat("a")).toEqual([]);
  expect((await listChats()).map((c) => c.id)).toEqual(["b"]);
  expect((await loadChat("b")).map((t) => t.content)).toEqual(["別の質問"]);
});
