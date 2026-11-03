// 長押しの間だけ聞き、短く押したら「送る」の合図にする。離したあとに届く文字も受け取ってから終わる
// 確かめるつもりで復唱する間だけマイクを動かし、訪問の話そのものは聞かない
// 送るつもりの短い押しでマイクを動かさないよう、少し押し続けてから聞き始める
const HOLD_MS = 300;
// 黙っていただけの失敗。これ以外は聞き直しても直らない
const HARMLESS = new Set(["no-speech", "aborted"]);
// 離したあとの文字がいつまでも届かないとき、ボタンを固めない
const FINISH_MS = 5000;

export const DEFAULT_KEY = "F2";
const FUNCTION_KEY = /^F\d+$/;
// 画面の移動やボタンの操作に使うキーは、録音に当てない
// Ctrl や Alt はブラウザの操作に使うので、録音に割り当てない
const canBind = (code) => Boolean(code) && !["Tab", "Escape", "Space", "Enter"].includes(code) && !/^(?:Control|Alt|Meta|Shift|OS)/.test(code);
export const keyCode = (e) => e.code || e.key;
export const keyLabel = (code) => code.replace(/^Key/, "").replace(/^Digit/, "");
export const chooseKey = (e) => (canBind(keyCode(e)) ? keyCode(e) : null);
// 文字を打っている間は、そのキーを文字として扱う。ファンクションキーは文字にならないので、いつでも効く
export const keyTriggers = (code, bound, typing) => code === bound && (!typing || FUNCTION_KEY.test(code));

export function createPushToTalk({ Recognition, onText, onInterim, onState, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let recognition = null;
  let timer = null;
  let held = false;
  let finishTimer = null;
  let earlier = "";
  let failed = false;

  function finish() {
    clearTimer(finishTimer);
    finishTimer = null;
    if (!failed) onState("idle");
  }

  function listen() {
    let finals = "";
    let interim = "";
    recognition = new Recognition();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      const results = [...e.results];
      // 毎回全部から作り直す。同じ結果がもう一度届いても二重にしない
      finals = results.filter((r) => r.isFinal).map((r) => r[0].transcript).join("");
      onText(earlier + finals);
      interim = results.filter((r) => !r.isFinal).map((r) => r[0].transcript).join("");
      onInterim(interim);
    };
    recognition.onerror = (e) => {
      if (HARMLESS.has(e.error)) return;
      held = false;
      failed = true;
      onState("error", e.error);
    };
    recognition.onend = () => {
      recognition = null;
      // 確定しないまま終わった文字も、話した内容なので残す
      earlier += finals + interim;
      if (interim) onText(earlier);
      onInterim("");
      // 押している間に黙ると、音声認識のほうが先に終わることがある
      if (held) { listen(); return; }
      finish();
    };
    try {
      recognition.start();
    } catch {
      recognition = null;
      held = false;
      failed = true;
      onState("error", "start");
    }
  }

  function stopListening() {
    held = false;
    onState("finishing");
    const current = recognition;
    current?.stop();
    finishTimer = setTimer(() => {
      if (current) {
        current.onresult = null;
        current.onerror = null;
        current.onend = null;
      }
      if (recognition === current) recognition = null;
      onInterim("");
      finish();
    }, FINISH_MS);
  }

  function cancelWaiting() {
    clearTimer(timer);
    timer = null;
  }

  return {
    press() {
      // 前の分の文字を待っている間は、押しても受け付けない。途中の文字を送らないため
      if (held || timer !== null || recognition) return false;
      earlier = "";
      failed = false;
      timer = setTimer(() => {
        timer = null;
        held = true;
        onState("listening");
        listen();
      }, HOLD_MS);
      return true;
    },
    // 指を離した
    release() {
      if (timer !== null) {
        cancelWaiting();
        onState("tap");
      } else if (held) {
        stopListening();
      }
    },
    // 録音か、文字の待ち時間か。この間は文字が変わるので、送らない
    busy: () => held || timer !== null || recognition !== null,
    // 指がボタンの外で離れた、別の画面へ移った。送らない
    cancel() {
      if (timer !== null) cancelWaiting();
      else if (held) stopListening();
    },
  };
}
