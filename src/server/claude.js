// 本物の Claude への窓口。答えはそのまま使わず、決まりに合うものだけを通す
import { minutesIn, parseMinutes } from "../core/normalize.js";
import { personalKind } from "../core/redact.js";
import { COMMON_YARDSTICKS, OUTPUT_READER, OUTPUT_READER_TARGETS, READER, READER_TARGETS, SCRIBE_PATHS, checkPrompt, scribePrompt } from "./prompts.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_FINDINGS = 6;

// 点検の指摘に残さない医療の判断。声メモの事実（「認知症で夜に歩く」）はここに当てない
const MEDICAL = /(?:薬|インスリン|歩行器|点滴|酸素|杖|車いす|補聴器|リハビリ|透析).{0,12}(?:中止|不要|要りません|いりません)|歩けるように|症状|発作|低血糖|命に関わ|切れると|(?:歩か|動か)ない(?:ほう|方)|(?:転倒|転ん|体調).{0,6}おそれ|(?:降圧|血糖|脱水|誤嚥|骨折|痛み止め|インスリン|座薬|透析).{0,20}(?:量|多い|少な|続け|相談|恐れ|危険|下が|上が|打っ|使い|控え|避け)|(?:医者|かかりつけ医).{0,12}(?:相談|診|行)|(?:足|腰|歩く|水分|食事|体(?!育)|車いす).{0,16}(?:ほうがよ|ほうがい|とよい|といい|控え)|診断|処方|服薬|服用|投薬|減薬|薬の量|薬[をは]?.{0,6}(?:増|減|控|やめ|止め|変え|飲|半分|大丈夫)|飲まなく|受診|治療|入院|血圧[がは]|悪化|疑われ|認知症|糖尿病|脳梗塞|心臓|病院で|医師に|診て|酸素.{0,6}(?:外|やめ|止め|減|増)/;
// 書き取りで止めるのは、やめる・止めるといった指図だけ
// 本人の事実（「酸素を外すと息が苦しい」「薬は半分に割って飲む」）は止めない
const MEDICAL_ORDER = /(?:薬|酸素|インスリン|透析|降圧|痛み止め).{0,8}(?:やめ(?!た(?!ほう|方))|止め|減らす|減らし|増やす|増やし|控え|外す(?!と)|外して(?!は)|半分(?!に割)|飲まな(?!いと|くなった)|打たな(?!いと|くなった)|なくてよい|なくていい)/;
// 体のことと人のことは、聞いていない文を計画に入れない。値の言葉が根拠の文か、今の欄の中身にあるときだけ通す（前の話を足していく欄があるため）
const NEEDS_QUOTE = /受診|診察|入院|必ず|迎え|担当|決ま|薬|降圧|インスリン|痛み止め|認知症|血圧|血糖|透析|座薬|酸素|点滴|注射|娘|息子|嫁|婿|孫|(?<!丈)夫|妻|兄|姉|弟|妹|母|父|車|無線|電話|メール|ラジオ|テレビ/g;
const wordsInQuote = (value, source) => {
  const text = squeeze(source).replace(/おくすり|くすり/g, "薬").replace(/携帯/g, "携帯電話");
  return (value.match(NEEDS_QUOTE) ?? []).every((w) => text.includes(w));
};
const currentValue = (plan, path) => {
  const f = path.split(".").reduce((o, k) => o?.[k], plan);
  return typeof f?.value === "string" ? f.value : "";
};
// 頼みごとの案に残さない形。「手伝います」は約束、「手を貸してください」「電話を1本お願いします」は頼みごと
const REQUEST_BAD = /(?<!お願いし|お願いいたし|助かり)ます$|ました$|要りません|いりません|決まり|決まった|ましょう$|お任せください$|(?<!ま)[うくすつぬぶむるぐ]$|主治医|病院へ|安静|もう安心|手元にあります|\[(?:お名前|住所|日付|電話番号|郵便番号|手元の値)\]/;
// 指摘の文に残さない約束。頼みごとの案には、下の PROMISE でさらに広く当てる。「必ず届くとは限らない」「毎晩おひとり」は事実の話
const FIRM = /してくれます|来てくれます|ことになりました|てあげ|必ず(?!.{0,8}とは限)|かならず|絶対|ぜったい|約束|責任を持|責任をも|義務|迎えに行|迎えに来ます|してあげ|連絡します|電話します/;
const PROMISE = /てあげ|必ず|かならず|絶対|ぜったい|毎回|毎晩|約束|責任を持|責任をも|義務|迎えに行|迎えに来ます|してあげ|連絡します|電話します/;
// 計画は下書きなので、決まった、大丈夫と言い切る文と、相手に連絡する文、受診の指図は残さない。「まだ決まっていません」は通す
const DECIDED = /もう大丈夫|これで安心|間に合う|電話して(?!くれ|もらえ)|伝えておき|もう安心|これで大丈夫|問題ありません|心配ありません|避難できます|決まっている(?:の|から)|決まっています|決まりました|決まった(?:[。]|$|ので|から)|完成|安全です|間に合います|連絡を入れ|連絡して(?!くれ|もらえ)|お伝えし|電話をかけ(?!て?くれ|て?もらえ|られ|そう)|病院へ|主治医|安静|いりません/;

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
  const { consent, consentInput, nextSteps, requests, requestsDone, ...rest } = plan;
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
// 市に渡す書類に直結するので、頼み終えた言い方だけを見る。希望や予定、返事待ちは入れない
const ASKED = /頼んだ|頼みました|頼んであ|頼んでい|頼んでます|頼めた|頼めました|お願いした|お願いしました|お願いしてあ|お願いしてい|お願いしてます|引き受けて|引き受けた/;
// 頼む言葉のあとの否定は、形を問わず頼んでいないと見る
const NEGATED = /(?:頼|お願い|引き受).*(?:ない|なく|なか|ません|ず)/;
const NOT_ASKED = /たい|たかった|たら|だら|ほうが|方が|ほしい|欲しい|そう|いいか|迷|けど|けれど|無理|難し|てくれるか|にくい|づらい|頼んでみ|ようと思|つもり|まだ|断られ|断わられ|返事待ち|返事を待|分から|わから/;
const DECLINED = /断られ|断わられ|引き受けられない/;
// 呼び名は続き柄か位置で書く。分からないものは名前かもしれないので、一般の呼び方にする
const RELATION = /となり|奥|家内|甥|姪|いとこ|ばあ|じい|ケアマネ|長男|次男|三男|長女|次女|三女|主人|旦那|区長|班長|組長|会長|隣|近所|近く|向かい|同じ|娘|息子|嫁|婿|孫|夫|妻|兄|姉|弟|妹|親|母|父|祖|家族|友|知り合い|民生|委員|職員|ヘルパー/;
// 音声認識は句点を打たず空白で続けるので、空白の切れ目も文の切れ目として見る。引用がまたぐときは文全体を見る
function sentenceOf(quote, memo) {
  const sentence = memo.split(/[。！？!?\n]/).find((s) => squeeze(s).includes(squeeze(quote))) ?? "";
  return sentence.split(/[\s　]+/).find((part) => squeeze(part).includes(squeeze(quote))) ?? sentence;
}
// 呼び名の中心の言葉が、根拠の文に出ていること。「娘に頼んだ」を根拠に息子さんを入れない
const sameNeighbor = (text) => text.replace(/となり/g, "隣");
const namesPerson = (alias, quote) => sameNeighbor(squeeze(quote)).includes(sameNeighbor(alias.match(RELATION)?.[0] ?? squeeze(alias)));
// 置き換えの記号のまま計画に入れると、ご本人に共有する紙と市向けの CSV に記号が出る
const PLACEHOLDER = /\[(?:お名前|住所|日付|電話番号|郵便番号|手元の値|メール)\]|手元にあります/;
// 答えをまだ聞いていない問いかけは、根拠にしない。文の終わりで見るので、引用から「か」を抜いても通らない
// 「公民館ですかね」は考えながらの復唱でもあるので、ここでは捨てず Claude の判断と人の確認に任せる
const QUESTION = /(?:ます|です|でしょう|ません|ない|ある|いる|した)か\s*$/;
// 「公民館でいい？」「公民館はどうかな」のように、相手に尋ねている文
// 「公民館でいいです」は答えなので、「か」のあるときだけ尋ねている文と見る
const OFFER = /(?:でいい|でよろしい)(?:です)?(?:か|かな)\s*$|(?:どうかな|いいかな|どうですか|どうでしょう|いかが)(?:です)?(?:か|かな)?\s*$/;
function isAsking(quote, memo) {
  const sentence = sentenceOf(quote, memo);
  if (QUESTION.test(sentence) || OFFER.test(sentence)) return true;
  // 文の終わりの「？」も見る。引用が文の途中まででも通さない
  const at = memo.indexOf(sentence);
  return at >= 0 && /[?？]/.test(memo.slice(at + sentence.length, at + sentence.length + 1));
}

export function acceptColumns(results, columns, targets = READER_TARGETS) {
  const byHeader = new Map(results.map((r) => [r.header, r]));
  return columns.map(({ header }) => {
    const hit = byHeader.get(header);
    return hit && targets.includes(hit.target) && hit.target !== "unknown"
      ? { header, target: hit.target, confidence: hit.confidence }
      : { header, target: "unknown", confidence: "low" };
  });
}

// メモに根拠の無い書き込みは捨てる。聞いていないことを計画に入れない
export function acceptScribe({ updates, helpers }, memo, fields = [], plan = {}) {
  const accepted = [];
  const allowed = new Set([...SCRIBE_PATHS, ...fields.map((f) => f.key)]);
  for (const { path, value, quote } of updates) {
    if (!allowed.has(path) || !isQuoted(quote, memo) || isAsking(quote, memo) || personalKind(value) || PLACEHOLDER.test(value) || MEDICAL_ORDER.test(value)) continue;
    if (path.endsWith(".noOthers")) {
      if (value === "true" && /ほか|他/.test(quote) && /ない|なし|ません/.test(quote)) accepted.push({ path, value: true });
      continue;
    }
    if (path.endsWith("Minutes")) {
      // 値の分数が、根拠の文に出てくる時間と合っているか
      const minutes = parseMinutes(value);
      // 「1時間15分」の一部だけを引用しても通らないよう、文全体で見る
      if (minutes !== null && minutesIn(sentenceOf(quote, memo)).includes(minutes)) accepted.push({ path, value: String(minutes) });
      continue;
    }
    const text = value.trim();
    if (text === "" || (SAME_WORDS.has(path) && !sharesWords(text, memo)) || !wordsInQuote(text, `${sentenceOf(quote, memo)}${quote}${currentValue(plan, path)}`)) continue;
    // 名字と同じ地名が呼び名に置き換わった文を、避難先にしない
    if (/^(?:evacuation\.place|evacuation\.means|evacuation\.route)$/.test(path) && /^(?:本人|緊急連絡先)/.test(text)) continue;
    accepted.push({ path, value: text });
  }
  let unnamed = 0;
  for (const { alias, awayWeekdayDaytime, asked, quote } of helpers) {
    if (!isQuoted(quote, memo) || isAsking(quote, memo) || alias.trim() === "" || personalKind(alias) || PLACEHOLDER.test(alias) || !namesPerson(alias, quote)) continue;
    // 頼んだかどうかは、ご本人に共有する紙と CSV に直結するので、その人の文だけで確かめる
    const sentence = sentenceOf(quote, memo);
    // 「娘に頼みました、隣の人には来週話します」で隣の人を頼めたにしない。その人を含む節だけで見る
    const clause = sentence.split(/[、,，]/).find((part) => namesPerson(alias, part)) ?? sentence;
    const reallyAsked = asked === true && ASKED.test(clause) && !NOT_ASKED.test(sentence) && !NEGATED.test(sentence);
    const declined = DECLINED.test(sentence);
    unnamed += RELATION.test(alias) ? 0 : 1;
    const name = RELATION.test(alias) ? alias.trim() : unnamed === 1 ? "近くの人" : `近くの人${unnamed}`;
    accepted.push({ path: "helpers.add", value: { alias: name, awayWeekdayDaytime, asked: reallyAsked, ...(declined ? { declined: true } : {}) } });
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
    // 「透析の日の昼に、そばにいる人をまだ聞けていません」は医療の判断ではない
    // まだ聞けていないという指摘と、場所を尋ねる問いかけは、判断でも約束でもない
    const notAsked = (t) => /(?:聞けて|聞いて|書かれて|話せて)いません[。]?$|聞いておきたいです[。]?$|(?:どこ|どちら|どなた|誰).*か[。？]?$/.test(t);
    const bad = (t) => personalKind(t) || (!notAsked(t) && (MEDICAL.test(t) || FIRM.test(t) || DECIDED.test(t)));
    // 指摘の文がだめなら捨てる。問いかけだけがだめなら、問いかけだけ外す（一緒の頼みごとの案を失わない）
    if (f.text && bad(f.text)) continue;
    const interrupt = f.interrupt === true && Boolean(f.opener) && !bad(f.opener);
    const kind = interrupt ? "ask" : f.request ? "request" : "note";
    // 番号は決まった作り方にする。同じ物差しの割り込みを何度も出さないため
    const base = `y${index}-${kind}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const finding = { id: n === 1 ? base : `${base}-${n}`, yardstick: f.yardstick, text: f.text };
    if (interrupt) Object.assign(finding, { interrupt: true, opener: f.opener });
    // 「手伝います」のような約束は、ご本人に共有する紙に載せない
    const asking = f.request?.replace(/（[^）]*）$/, "").replace(/[。]$/, "");
    if (f.request && !MEDICAL.test(f.request) && !personalKind(f.request) && !PROMISE.test(f.request) && !REQUEST_BAD.test(asking)) finding.request = f.request;
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
    async readColumns({ kind, columns }) {
      const output = kind === "output";
      const { results } = await ask("reader", output ? OUTPUT_READER : READER, { columns });
      return { results: acceptColumns(results, columns, output ? OUTPUT_READER_TARGETS : READER_TARGETS) };
    },
    async scribe({ memo, plan, fields = [] }) {
      const answer = await ask("scribe", scribePrompt(fields), { memo, plan: summarizePlan(plan), fields });
      const updates = acceptScribe(answer, memo, fields, plan);
      // 捨てたものがあれば画面で知らせる
      return { updates, dropped: answer.updates.length + answer.helpers.length - updates.length };
    },
    async check({ plan, gaps, blanks = [], fields = [] }) {
      const { findings } = await ask("check", checker, { plan: summarizePlan(plan), gaps, blanks, fields });
      const time = timeFinding(plan, village.evacuationTargetMinutes);
      return { findings: [...acceptFindings(findings, yardsticks), ...(time ? [time] : [])] };
    },
  };
}
