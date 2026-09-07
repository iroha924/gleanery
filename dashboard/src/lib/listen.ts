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
 * `onError` は繋がらなかったときにだけ呼ぶ。**流れている途中の失敗で会議を止めない** —
 * 片方が落ちても、もう片方は録れているほうが役に立つ。
 */
export function listen(
  stream: MediaStream,
  token: string,
  onHeard: (h: Heard) => void,
  onError: (message: string) => void,
): () => void {
  const ws = new WebSocket(URL_REALTIME, ["realtime", `openai-insecure-api-key.${token}`]);
  const ctx = new AudioContext({ sampleRate: 24000 });
  let stopped = false;

  const close = () => {
    stopped = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    ctx.close().catch(() => {});
  };

  ws.onerror = () => {
    if (!stopped) onError("聞き取りに繋がらなかった");
  };

  ws.onmessage = (e) => {
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

  ws.onopen = async () => {
    try {
      const url = window.URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      window.URL.revokeObjectURL(url);
      if (stopped) return;
      const node = new AudioWorkletNode(ctx, "pcm");
      node.port.onmessage = (m) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: encode(m.data as Float32Array) }));
      };
      // **出力へは繋がない。**繋ぐと自分の声がスピーカーへ返り、会議に回り込む。
      ctx.createMediaStreamSource(stream).connect(node);
    } catch {
      onError("音を取り出せなかった");
    }
  };

  return close;
}
