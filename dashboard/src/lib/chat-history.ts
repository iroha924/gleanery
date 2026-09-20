// チャットの履歴。browser の中にだけ置く。
//
// サーバーへ書き込み経路を作らない。チャットの答えには PR・issue から読んだ第三者の文章が混ざるので、
// その出口に書き込みを持たせない（`ui-hono` Skill「書き込みの鍵を `server/src/http/` へ持ち込まない」）。
//
// **記録の正本ではなく、読み返すための控えである。**DB の knowledge / message には入らないので、
// recall と検索が自分の出力を自分の根拠に引く輪はできない。
//
// 作業場所は数値 ID ではなく `project.key` で持つ。DB を作り直すと同じ ID が別の作業場所を指す。

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ChatSource } from "./api";
import { useProject } from "./project";

const NAME = "gleanery-chat";
const VERSION = 1;
const CHAT = "chat";
const TURN = "turn";

/** 1 往復。履歴が保存する形そのものなので、画面をまたぐここに置く。 */
export type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  error?: string;
  stopped?: boolean;
};

export type ChatEntry = {
  id: string;
  title: string;
  projectKey: string;
  projectLabel: string;
  createdAt: string;
  updatedAt: string;
};

type StoredTurn = Turn & { chatId: string; at: number };

const promised = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB が失敗した"));
  });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHAT)) {
        db.createObjectStore(CHAT, { keyPath: "id" }).createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(TURN)) {
        // 題の一覧を出すのに往復の本文まで読まないよう、store を分ける。
        db.createObjectStore(TURN, { keyPath: "id" }).createIndex("chatId", "chatId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("履歴の DB を開けなかった"));
  });
}

/** 新しいものから順に。作業場所を渡せばそれだけに絞る。 */
export async function listChats(projectKey?: string): Promise<ChatEntry[]> {
  const db = await open();
  const all = await promised<ChatEntry[]>(db.transaction(CHAT, "readonly").objectStore(CHAT).getAll());
  db.close();
  return all
    .filter((c) => projectKey === undefined || c.projectKey === projectKey)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadChat(id: string): Promise<Turn[]> {
  const db = await open();
  const turns = await promised<StoredTurn[]>(
    db.transaction(TURN, "readonly").objectStore(TURN).index("chatId").getAll(id),
  );
  db.close();
  return turns.sort((a, b) => a.at - b.at).map(({ chatId: _c, at: _a, ...turn }) => turn);
}

/**
 * 1 つの会話を丸ごと置き換える。**往復の途中では呼ばない** — 流れている最中に書くと、
 * 部分的な答えと、取り直した後の答えが二重に残る。
 */
export async function saveChat(entry: ChatEntry, turns: Turn[]): Promise<void> {
  const db = await open();
  const tx = db.transaction([CHAT, TURN], "readwrite");
  tx.objectStore(CHAT).put(entry);
  const store = tx.objectStore(TURN);
  const index = store.index("chatId");
  // 置き換えなので、この会話の古い往復を先に消す（畳んだ・取り直した往復を残さない）。
  for (const key of await promised<IDBValidKey[]>(index.getAllKeys(entry.id))) store.delete(key);
  for (const [order, turn] of turns.entries()) {
    store.put({ ...turn, chatId: entry.id, at: order } satisfies StoredTurn);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("履歴を書けなかった"));
  });
  db.close();
}

export async function deleteChat(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([CHAT, TURN], "readwrite");
  tx.objectStore(CHAT).delete(id);
  const store = tx.objectStore(TURN);
  for (const key of await promised<IDBValidKey[]>(store.index("chatId").getAllKeys(id))) store.delete(key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("履歴を消せなかった"));
  });
  db.close();
}

// ---- 一覧の取り回し ----

// **キャッシュと無効化を自分で持たない。**provider と useEffect で書いていたが、
// 保存のあと一覧を読み直す経路が依存配列の identity に載り、止まる理由を別の effect の
// 副作用に頼っていた。queryKey が同じなら Query が 1 つの状態を配るので、サイドバーと
// チャットの画面が別々の state を持つ問題も消える。
const KEY = "chat-history";

export function useChatHistory() {
  const { project } = useProject();
  const projectKey = project?.key ?? null;
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: [KEY] });

  const list = useQuery({
    queryKey: [KEY, projectKey],
    queryFn: projectKey === null ? skipToken : () => listChats(projectKey),
  });

  const save = useMutation({
    mutationFn: ({ entry, turns }: { entry: ChatEntry; turns: Turn[] }) => saveChat(entry, turns),
    onSuccess: invalidate,
    onError: () => toast.error("チャットの履歴を書けなかった"),
  });

  const remove = useMutation({
    mutationFn: deleteChat,
    onSuccess: invalidate,
    onError: () => toast.error("その会話を消せなかった"),
  });

  return { entries: list.data ?? [], save, remove };
}
