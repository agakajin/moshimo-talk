// 本物の Claude への窓口。答えはそのまま使わず、決まりに合うものだけを通す
import { minutesIn, parseMinutes } from "../core/normalize.js";
import { personalKind } from "../core/redact.js";
import { COMMON_YARDSTICKS, READER, READER_TARGETS, SCRIBE, SCRIBE_PATHS, checkPrompt } from "./prompts.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_FINDINGS = 6;

// 点検の指摘に残さない医療の判断。声メモの事実（「認知症で夜に歩く」）はここに当てない
const MEDICAL = /診断|処方|服薬|服用|投薬|減薬|薬の量|薬[をは]?.{0,6}(?:増|減|控|やめ|止め|変え|飲|半分|大丈夫)|飲まなく|受診|治療|入院|血圧[がは]|悪化|疑われ|認知症|糖尿病|脳梗塞|心臓|病院で|医師に|診て|酸素.{0,6}(?:外|やめ|止め|減|増)/;
// 書き取りで止めるのは、やめる・止めるといった指図だけ
const MEDICAL_ORDER = /(?:薬|酸素|インスリン|透析).{0,8}(?:やめ|止め|減らす|増やす|控え|外す|外して)/;
const PROMISE = /必ず|かならず|絶対|ぜったい|毎回|毎晩|約束|責任を持|責任をも|義務|迎えに行|迎えに来ます|してあげ|連絡します|電話します/;

export class ClaudeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
  }
}

function toClaudeError(e) {
  if (e instanceof ClaudeError) return e;
  if (e.status === 429 || e.status === 529) return new ClaudeError("Claude が混み合っています。少し時間をおいてお試しください", 503);
  return new ClaudeError("Claude につながりませんでした", 502);
}

// 欄の入れ物を外し、入っている値だけにする。送る量を減らし、番号や状態を Claude に渡さない
export function summarizePlan(plan) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.length ? node : undefined;
    if (node === null || typeof node !== "object") return node === false ? undefined : node ?? undefined;
    if ("status" in node) return node.value ?? undefined;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const value = walk(v);
      if (value !== undefined) out[k] = value;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const { consent, nextSteps, requests, requestsDone, ...rest } = plan;
  return walk(rest) ?? {};
}

const squeeze = (text) => String(text).replace(/[\s　、。，．,.]/g, "");
const isQuoted = (quote, memo) => squeeze(quote).length >= 2 && squeeze(memo).includes(squeeze(quote));
// 固有の言葉が入る欄は、値がメモの言葉を使っているか調べる。ほかの欄は言い換えやまとめがあるので調べない
const SAME_WORDS = new Set(["evacuation.place", "home.community", "home.bedroom", "home.usualRoom"]);
function sharesWords(value, memo) {
  const v = squeeze(value);
  const m = squeeze(memo);
  for (let i = 0; i + 2 <= v.length; i += 1) if (m.includes(v.slice(i, i + 2))) return true;
  return false;
}
const ASKED = /頼ん|頼み|お願いし|引き受/;
const NOT_ASKED = /頼んでいない|頼んでない|頼んでません|頼めていない|お願いしていない|お願いしてない|お願いしてません|頼んでみる|つもり|まだ/;
// 呼び名は続き柄か位置で書く。分からないものは名前かもしれないので、一般の呼び方にする
const RELATION = /隣|近所|近く|向かい|同じ|娘|息子|嫁|婿|孫|夫|妻|兄|姉|弟|妹|親|母|父|祖|家族|友|知り合い|民生|委員|職員|ヘルパー/;
const sentenceOf = (quote, memo) => memo.split(/[。！？!?\n]/).find((s) => squeeze(s).includes(squeeze(quote))) ?? "";
// 答えをまだ聞いていない問いかけは、根拠にしない。文の終わりで見るので、引用から「か」を抜いても通らない
const QUESTION = /(?:ます|です|でしょう|ません|ない|ある|いる|した)か(?:ね|な)?\s*$/;
const isAsking = (quote, memo) => QUESTION.test(sentenceOf(quote, memo)) || /[?？]/.test(memo.slice(memo.indexOf(quote) + quote.length, memo.indexOf(quote) + quote.length + 1));

export function acceptColumns(results, columns) {
  const byHeader = new Map(results.map((r) => [r.header, r]));
  return columns.map(({ header }) => {
    const hit = byHeader.get(header);
    return hit && READER_TARGETS.includes(hit.target) && hit.target !== "unknown"
      ? { header, target: hit.target, confidence: hit.confidence }
      : { header, target: "unknown", confidence: "low" };
  });
}

// メモに根拠の無い書き込みは捨てる。聞いていないことを計画に入れない
export function acceptScribe({ updates, helpers }, memo) {
  const accepted = [];
  for (const { path, value, quote } of updates) {
    if (!SCRIBE_PATHS.includes(path) || !isQuoted(quote, memo) || isAsking(quote, memo) || personalKind(value) || MEDICAL_ORDER.test(value)) continue;
    if (path.endsWith(".noOthers")) {
      if (value === "true" && /ほか|他/.test(quote) && /ない|なし|ません/.test(quote)) accepted.push({ path, value: true });
      continue;
    }
    if (path.endsWith("Minutes")) {
      // 値の分数が、根拠の文に出てくる時間と合っているか
      const minutes = parseMinutes(value);
      if (minutes !== null && minutesIn(quote).includes(minutes)) accepted.push({ path, value: String(minutes) });
      continue;
    }
    const text = value.trim();
    if (text === "" || (SAME_WORDS.has(path) && !sharesWords(text, memo))) continue;
    accepted.push({ path, value: text });
  }
  let unnamed = 0;
  for (const { alias, awayWeekdayDaytime, asked, quote } of helpers) {
    if (!isQuoted(quote, memo) || isAsking(quote, memo) || alias.trim() === "" || personalKind(alias)) continue;
    // 頼んだかどうかは本人の1枚と CSV に直結するので、メモの言葉で確かめる。何人も出る話では、その人の文だけを見る
    const sentence = sentenceOf(quote, memo);
    const about = ASKED.test(sentence) || helpers.length > 1 ? sentence : memo;
    const reallyAsked = asked === true && ASKED.test(about) && !NOT_ASKED.test(about);
    unnamed += RELATION.test(alias) ? 0 : 1;
    const name = RELATION.test(alias) ? alias.trim() : unnamed === 1 ? "近くの人" : `近くの人${unnamed}`;
    accepted.push({ path: "helpers.add", value: { alias: name, awayWeekdayDaytime, asked: reallyAsked } });
  }
  return accepted;
}


export function acceptFindings(findings, yardsticks) {
  const labels = yardsticks.map((y) => y.label);
  const seen = new Map();
  const accepted = [];
  for (const f of findings) {
    const index = labels.indexOf(f.yardstick);
    if (index < 0 || accepted.length >= MAX_FINDINGS) continue;
    if ([f.text, f.opener, f.request].some((t) => t && (MEDICAL.test(t) || personalKind(t)))) continue;
    if ([f.text, f.opener].some((t) => t && PROMISE.test(t))) continue;
    const interrupt = f.interrupt === true && Boolean(f.opener);
    const kind = interrupt ? "ask" : f.request ? "request" : "note";
    // 番号は決まった作り方にする。同じ物差しの割り込みを何度も出さないため
    const base = `y${index}-${kind}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const finding = { id: n === 1 ? base : `${base}-${n}`, yardstick: f.yardstick, text: f.text };
    if (interrupt) Object.assign(finding, { interrupt: true, opener: f.opener });
    if (f.request && !PROMISE.test(f.request)) finding.request = f.request;
    accepted.push(finding);
  }
  return accepted;
}

// 足し算は Claude に任せない
export function timeFinding(plan, targetMinutes) {
  const prep = plan?.evacuation?.prepMinutes;
  const move = plan?.evacuation?.moveMinutes;
  if (prep?.status !== "filled" || move?.status !== "filled") return null;
  const [a, b] = [parseMinutes(prep.value), parseMinutes(move.value)];
  if (a === null || b === null) {
    return { id: "in-time-unread", yardstick: "間に合うか", text: "準備か移動の時間を数字で読めませんでした。欄を確かめてください。" };
  }
  const total = a + b;
  if (!(total > targetMinutes)) return null;
  return { id: "in-time", yardstick: "間に合うか", text: `準備と移動で${total}分かかり、目安の${targetMinutes}分を超えます。` };
}

export function createClaude({ client, village, model = DEFAULT_MODEL, onUsage = () => {} }) {
  const yardsticks = [...COMMON_YARDSTICKS, ...village.yardsticks];
  const checker = checkPrompt(yardsticks);

  async function ask(role, { system, schema, effort, maxTokens }, input) {
    const started = Date.now();
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system,
        output_config: { effort, format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: JSON.stringify(input) }],
      });
    } catch (e) {
      // 中身はログに残さない
      console.error("Claude の呼び出しに失敗しました", role, e.name, e.status ?? "");
      throw toClaudeError(e);
    }
    onUsage({ role, model: response.model, usage: response.usage, ms: Date.now() - started });
    if (response.stop_reason === "refusal") throw new ClaudeError("Claude がこの内容には答えませんでした");
    if (response.stop_reason === "max_tokens") throw new ClaudeError("Claude の答えが長すぎて途中で切れました");
    const text = response.content.filter((b) => b.type === "text").at(-1)?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new ClaudeError("Claude の答えを読めませんでした");
    }
  }

  return {
    async readColumns(payload) {
      const { results } = await ask("reader", READER, payload);
      return { results: acceptColumns(results, payload.columns) };
    },
    async scribe({ memo, plan }) {
      const answer = await ask("scribe", SCRIBE, { memo, plan: summarizePlan(plan) });
      const updates = acceptScribe(answer, memo);
      // 捨てたものがあれば画面で知らせる
      return { updates, dropped: answer.updates.length + answer.helpers.length - updates.length };
    },
    async check({ plan, gaps }) {
      const { findings } = await ask("check", checker, { plan: summarizePlan(plan), gaps });
      const time = timeFinding(plan, village.evacuationTargetMinutes);
      return { findings: [...acceptFindings(findings, yardsticks), ...(time ? [time] : [])] };
    },
  };
}
