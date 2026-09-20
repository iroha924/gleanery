// チャットの履歴。browser の中にだけ置く。
//
// サーバーへ書き込み経路を作らない。チャットの答えには PR・issue から読んだ第三者の文章が混ざるので、
// その出口に書き込みを持たせない（`ui-hono` Skill「書き込みの鍵を `server/src/http/` へ持ち込まない」）。
//
// **記録の正本ではなく、読み返すための控えである。**DB の knowledge / message には入らないので、
// recall と検索が自分の出力を自分の根拠に引く輪はできない。
//
// 作業場所は数値 ID ではなく `project.key` で持つ。DB を作り直すと同じ ID が別の作業場所を指す。

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
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

// .tsx では `<T>` が JSX タグに見えるので、末尾のカンマで型引数だと示す。
const promised = <T,>(request: IDBRequest<T>): Promise<T> =>
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

// ---- 画面をまたぐ状態 ----

// サイドバーの一覧とチャットの画面が同じ一覧を見る。別々に読むと、質問した後どちらかが古いままになる。
type Ctx = {
  entries: ChatEntry[];
  /** 書いた後に呼ぶ。作業場所が選ばれていなければ空にする。 */
  reload: () => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const ChatHistoryContext = createContext<Ctx | null>(null);

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
  const { project } = useProject();
  const projectKey = project?.key ?? null;
  const [entries, setEntries] = useState<ChatEntry[]>([]);

  useEffect(() => {
    if (!projectKey) {
      setEntries([]);
      return;
    }
    listChats(projectKey)
      .then(setEntries)
      .catch(() => toast.error("チャットの履歴を読めなかった"));
  }, [projectKey]);

  const reload = async () => setEntries(projectKey ? await listChats(projectKey) : []);

  const remove = async (id: string) => {
    try {
      await deleteChat(id);
      await reload();
    } catch {
      toast.error("その会話を消せなかった");
    }
  };

  return (
    <ChatHistoryContext.Provider value={{ entries, reload, remove }}>{children}</ChatHistoryContext.Provider>
  );
}

export function useChatHistory(): Ctx {
  const ctx = useContext(ChatHistoryContext);
  if (!ctx) throw new Error("ChatHistoryProvider の外で useChatHistory を呼んでいる");
  return ctx;
}
