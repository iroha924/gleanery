// 会議の音声を OpenAI の Realtime へ流し続ける。
//
// **区切りを自分で決めない。**固定秒で切ると語の途中に切れ目が落ちるうえ、
// 「聞かれている最中」に間に合わない。Realtime は話しながら文字が返る。

const URL_REALTIME = "wss://api.openai.com/v1/realtime?intent=transcription";

/** 音を溜めずにそのまま渡すだけの処理器。**AudioWorklet は別ファイルを要求する**ので Blob で渡す。 */
const WORKLET = `class P extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor("pcm", P);`;

/** Float32 (-1..1) を 16bit PCM の base64 へ。**Realtime は 24kHz mono の PCM しか受けない。** */
function encode(f32: Float32Array): string {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i] ?? 0));
    i16[i] = v * 0x7fff;
  }
  const bytes = new Uint8Array(i16.buffer);
  // **一度に String.fromCharCode へ渡さない。**引数が数万個になると落ちる。
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export type Heard = {
  /** 発話ごとの id。delta で伸び、completed で確定する。 */
  itemId: string;
  text: string;
  done: boolean;
};

/**
 * 1 系統を流し続ける。返るのは止めるための関数。
 *
 * **一時鍵は 10 分で切れる。**1 時間の会議なら 5 回張り直すことになるので、切れたら
 * 鍵を取り直して繋ぎ直す。音の経路（AudioContext と Worklet）は作り直さない —
 * 作り直すとその間の音が落ちるうえ、マイクの立ち上がりをもう一度待つことになる。
 *
 * `onError` は繋ぎ直しても駄目だったときにだけ呼ぶ。**一度の切断で会議を止めない。**
 */
export function listen(
  stream: MediaStream,
  getToken: () => Promise<string>,
  onHeard: (h: Heard) => void,
  onError: (message: string) => void,
): () => void {
  const ctx = new AudioContext({ sampleRate: 24000 });
  let ws: WebSocket | null = null;
  let stopped = false;
  let retries = 0;

  const close = () => {
    stopped = true;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    ws = null;
    ctx.close().catch(() => {});
  };

  const connect = async () => {
    if (stopped) return;
    let token: string;
    try {
      token = await getToken();
    } catch {
      onError("聞き取りの鍵を取り直せなかった");
      return;
    }
    if (stopped) return;

    const sock = new WebSocket(URL_REALTIME, ["realtime", `openai-insecure-api-key.${token}`]);
    ws = sock;

    sock.onopen = () => {
      retries = 0;
    };

    sock.onmessage = (e) => {
      const ev = JSON.parse(e.data as string) as {
        type: string;
        item_id?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };
      if (ev.type === "conversation.item.input_audio_transcription.delta" && ev.item_id) {
        onHeard({ itemId: ev.item_id, text: ev.delta ?? "", done: false });
      } else if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.item_id) {
        onHeard({ itemId: ev.item_id, text: ev.transcript ?? "", done: true });
      } else if (ev.type === "error") {
        onError(ev.error?.message ?? "聞き取りが止まった");
      }
    };

    // 鍵切れも回線の瞬断も、閉じた事実としては同じ。数えて諦めるまで張り直す。
    sock.onclose = () => {
      if (stopped || ws !== sock) return;
      retries += 1;
      if (retries > 5) {
        onError("聞き取りが切れたまま戻らなかった");
        return;
      }
      setTimeout(connect, Math.min(retries * 500, 3000));
    };
  };

  void (async () => {
    try {
      const url = window.URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      window.URL.revokeObjectURL(url);
      if (stopped) return;
      const node = new AudioWorkletNode(ctx, "pcm");
      node.port.onmessage = (m) => {
        // 繋ぎ直している最中の音は捨てる。溜めても、会議はもう先へ進んでいる。
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: encode(m.data as Float32Array) }));
      };
      // **出力へは繋がない。**繋ぐと自分の声がスピーカーへ返り、会議に回り込む。
      ctx.createMediaStreamSource(stream).connect(node);
      await connect();
    } catch {
      onError("音を取り出せなかった");
    }
  })();

  return close;
}
