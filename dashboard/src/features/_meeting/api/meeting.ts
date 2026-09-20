import { api, type Reply } from "@/lib/api";

export type { Reply };

/** 相手の発話から返信案を引く。問われていない発言なら `asked` が false で返る。 */
export const askReply = (text: string, projects: number[]): Promise<Reply> => api.reply(text, projects);

/** 文字起こしの鍵。**10 分で切れる**ので、listen が要るたびに取り直す。 */
export const realtimeToken = api.realtimeToken;
