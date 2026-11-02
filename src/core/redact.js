// 声メモや文の列を Claude に渡す前に、手元の名前・住所・電話番号と、それらしい形を置き換える
// 画面からの送信は止めず、ここで置き換える。ふつうの話で訪問を止めないため
// 手元に無い人の名前は完全には見分けられない。続き柄で話す運用とあわせて使う
import { normalizeText, toHalfWidth, kataToHira, halfKanaToFull } from "./normalize.js";

const DIGIT = "0-9〇零一二三四五六七八九";
const SEP = "[\\-‐‑–—―−ーｰ.．の・,，、/／_()（）:：~〜\\s]";
const PHONE = new RegExp(`(?<![${DIGIT}])[${DIGIT}](?:${SEP}{0,3}[${DIGIT}]){8,10}(?![${DIGIT}])`, "g");
const COUNTRY_CODE = /\+\s*81[\s\-‐ー−()（）]*0?/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const NOT_DIGIT = new RegExp(`[^${DIGIT}]`, "g");
const SEP_RUN = new RegExp(`${SEP}+`);

const N = "[0-9一二三四五六七八九十〇元]{1,4}";
const GAP = "[の、\\s]*";
const YEAR = `(?:(?:明治|大正|昭和|平成|令和|昭|平|令)\\s*${N}|(?<![A-Za-z])[MTSHRmtshr]\\.?\\s*\\d{1,2}|(?:19|20)\\d{2})`;
// 年月だけの「平成30年7月の大雨」は災害の話なので残す。生まれた年や、生年月日と言った日付は置き換える
const DATE = new RegExp(
  `${YEAR}\\s*年${GAP}${N}\\s*月${GAP}${N}\\s*日?|${YEAR}\\s*[.\\/\\-]\\s*\\d{1,2}\\s*[.\\/\\-]\\s*\\d{1,2}(?!\\d)|${YEAR}\\s*年(?:${GAP}${N}\\s*月)?(?=に?生)|(?<=(?:生年月日|誕生日)[はがの:：\\s]{0,3})${N}\\s*年${GAP}${N}\\s*月${GAP}${N}\\s*日?|(?<!\\d)(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])(?!\\d)`,
  "g",
);
const POSTAL = /〒\s*\d{3}[-‐ー−]?\d{0,4}/g;
// 「三丁目の公民館」は場所の話なので、丁目だけでは置き換えない。「点字ブロック3枚」の字も住所ではない
const ADDRESS = /(?<![点文数漢赤名])大?字[\p{Script=Han}ァ-ヶ]{1,10}\s*\d+(?:\s*[-‐ー−番の]\s*\d+)*(?:番地|号)?|[0-9一二三四五六七八九十百]+\s*番地(?:\s*[0-9一二三四五六七八九十]+)?(?:\s*号)?|[0-9一二三四五六七八九十百]+\s*丁目\s*[0-9一二三四五六七八九十]+(?:\s*[-‐ー−番の]\s*\d+)*(?:\s*号)?/gu;

// 「さん」が付いても名前ではない言葉
const NOT_A_NAME = new Set([
  "本人", "緊急連絡先", "人", "方", "子", "皆", "赤", "猫", "犬", "ワン", "同", "模", "雨模", "多", "各", "王", "神", "仏",
  "娘", "息子", "奥", "嫁", "婿", "孫", "母", "父", "祖母", "祖父", "兄", "姉", "弟", "妹", "夫", "妻", "旦那", "親", "親戚", "甥", "姪", "叔母", "伯母", "叔父", "伯父",
  "長男", "次男", "三男", "長女", "次女", "三女", "義母", "義父", "家族", "兄弟", "姉妹", "親子",
  "隣", "近所", "大家", "民生", "民生委員", "委員", "担当", "職員", "運転手", "先生", "医者", "駐在", "社協", "施設", "郵便屋", "同様", "模様",
]);
const NOT_A_NAME_END = [
  "看護師", "看護婦", "ケアマネジャー", "ケアマネージャー", "ケアマネ", "ヘルパー", "会長", "区長", "班長", "組長", "役所", "デイサービス", "夫婦", "モ様",
  "娘", "息子", "奥", "嫁", "婿", "孫", "母", "父", "兄", "姉", "弟", "妹", "婆", "爺", "隣", "っ",
  "医者", "医師", "薬剤師", "美容師", "理容師", "管理人", "主人", "友人", "知人", "老人", "隣人", "住人", "ボランティア", "客", "看護", "デイ",
  "八百屋", "魚屋", "米屋", "酒屋", "床屋", "薬屋", "電気屋", "大工", "職員", "店員", "委員", "団員", "同じ", "たく", "疲れ", "苦労", "摂",
];
const NAME = /(?:[\p{Script=Han}々ァ-ヶー]+(?:(?![のにはをがとへもで])[ぁ-ゖ]){0,3})(?=さん(?!ざん)|様(?!子)|さま|氏|ちゃん|くん)/gu;
const isName = (word) => !NOT_A_NAME.has(word) && !NOT_A_NAME_END.some((end) => word.endsWith(end));

// 音声認識は普通の字を出しやすいので、字体をそろえて探す
const FOLD = { "髙": "高", "﨑": "崎", "𠮷": "吉", "齋": "斎", "齊": "斉", "濵": "浜", "濱": "浜", "邊": "辺", "邉": "辺", "德": "徳", "惠": "恵", "櫻": "桜", "廣": "広", "澤": "沢", "嶋": "島", "眞": "真", "壽": "寿", "國": "国", "榮": "栄", "瀧": "滝", "冨": "富", "塚": "塚" };
const fold = (s) => [...s.normalize("NFKC")].map((c) => FOLD[c] ?? c).join("");

const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const onlyKana = (s) => /^[ぁ-ゖァ-ヶー]+$/.test(s);
// 読みの短い部分（はじめ、なかの）は普通の言葉と重なるので、単独では置き換えない
const longEnough = (part) => part.length >= (onlyKana(part) ? 4 : 2);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 「平和台公民館」「川上橋」は、名前と同じ字で始まる地名として残す
const NOT_PLACE = "(?![台橋川山駅町村]|公民館|小学校|中学校|神社|団地|病院|地区|集落)";
// 「準備に10-15分」は番地ではない
const NOT_AMOUNT = "(?![0-9分人時歳回度階枚])";
const formPattern = (form, kind) => new RegExp(`${escapeRegExp(form)}${kind === "address" ? NOT_AMOUNT : NOT_PLACE}`, "g");

function variants(value) {
  const text = fold(normalizeText(value));
  const out = new Set();
  const add = (part) => { if (longEnough(part)) out.add(part); };
  [text, text.replace(/\s/g, ""), ...text.split(" ")].forEach(add);
  const hira = kataToHira(halfKanaToFull(text));
  for (const form of [hira, hiraToKata(hira)]) [form, form.replace(/\s/g, ""), ...form.split(" ")].forEach(add);
  return [...out];
}

// 短い読みは「さん」が付いたときだけ。一部分を置き換えて文を壊さない
function honorific(value) {
  const text = fold(normalizeText(value));
  const hira = kataToHira(halfKanaToFull(text));
  const parts = [...text.split(" "), ...hira.split(" "), ...hiraToKata(hira).split(" ")].filter((p) => p.length >= 2);
  return parts.flatMap((p) => [`${p}さん`, `${p}様`, `${p}さま`]);
}

// 住所は全部を言わないことが多いので、字名と番地でも探す。「ハッカ村」のように広い言葉は置き換えない
function addressVariants(value) {
  const text = toHalfWidth(fold(normalizeText(value)));
  const out = new Set([text, text.replace(/\s/g, "")]);
  const tail = /字.*$/.exec(text)?.[0] ?? text.replace(/^.*[都道府県市区村郡]/, "").trim();
  // 番地だけの短い形は、時間や人数と重なるので単独では置き換えない
  if (tail && !/^[\d\s\-‐ー−]{1,4}$/.test(tail)) {
    out.add(tail);
    out.add(tail.replace(/\s/g, ""));
  }
  const area = /^大?字?([^\d\s]+)/.exec(tail)?.[1];
  const lot = /(\d+)\s*[-‐ー−]\s*(\d+)(?:\s*[-‐ー−]\s*\d+)?/.exec(tail);
  if (lot) {
    const [, a, b] = lot;
    if (lot[0].length >= 5) out.add(lot[0]);
    const forms = [`${a}番地${b}`, `${a}番${b}号`, `${a}番${b}`, `${a}の${b}`];
    for (const form of forms) if (!form.endsWith(`の${b}`) || area) out.add(area ? `${area}${form}` : form);
    if (area) {
      out.add(`字${area}${lot[0]}`);
      out.add(`${area}${lot[0]}`);
      out.add(`大字${area}${lot[0]}`);
      forms.forEach((form) => out.add(`字${area}${form}`));
      forms.slice(0, 3).forEach((form) => out.add(form));
    }
  }
  // 字名だけ（「川上の公民館」）は場所の話なので残し、「字川上」と言ったときだけ置き換える
  if (area && area.length >= 2) {
    out.add(`字${area}`);
    out.add(`大字${area}`);
  }
  return [...out];
}

// どの形の名前や住所から置き換えても壊れないよう、長いものから置き換える
function replacements(known) {
  const pairs = [];
  for (const { value, alias, kind } of known) {
    if (!value || kind === "phone") continue;
    if (kind === "address") {
      for (const v of addressVariants(value)) pairs.push([v, alias, kind]);
      continue;
    }
    for (const v of [...variants(value), ...honorific(value)]) pairs.push([v, alias, kind]);
  }
  return pairs.sort(([a], [b]) => b.length - a.length);
}

function maskPhones(text) {
  return text.replace(COUNTRY_CODE, "0").replace(PHONE, (m) => {
    const digits = m.replace(NOT_DIGIT, "");
    const parts = m.split(SEP_RUN);
    // 区切りが多い数字は箇条書きが多いので除く。1桁ずつ読んだ番号だけは数える
    return /^[0〇零]/.test(digits) && digits.length >= 9 && (parts.length <= 4 || parts.every((p) => p.length === 1)) ? "[電話番号]" : m;
  });
}
const maskForms = (text) => maskPhones(text.replace(DATE, "[日付]").replace(POSTAL, "[郵便番号]")).replace(ADDRESS, "[住所]");
const maskNames = (text) => text.replace(NAME, (word) => (isName(word) ? "[お名前]" : word));

// 手元の番号は、下の桁だけを話したときも置き換える
function maskKnownPhones(text, known) {
  let out = text;
  for (const { value, kind } of known) {
    if (kind !== "phone" || !value) continue;
    const d = toHalfWidth(value).replace(/\D/g, "");
    if (d.length < 6) continue;
    out = out.replace(new RegExp(`(?<!\\d)${d.slice(-6, -4)}${SEP}{0,2}${d.slice(-4)}(?!\\d)`, "g"), "[電話番号]");
  }
  return out;
}

export function redact(text, known = []) {
  let out = fold(halfKanaToFull(normalizeText(String(text).replace(INVISIBLE, ""))));
  for (const [from, alias, kind] of replacements(known)) out = out.replace(formPattern(from, kind), () => alias);
  return maskNames(maskForms(maskKnownPhones(toHalfWidth(out), known)));
}

// 計画の文字すべてを置き換えて送る形にする。手で直した欄もここを通る
export function redactDeep(node, known = []) {
  if (typeof node === "string") return redact(node, known);
  if (Array.isArray(node)) return node.map((v) => redactDeep(v, known));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactDeep(v, known)]));
}

const standard = (text) => toHalfWidth(fold(halfKanaToFull(String(text).replace(INVISIBLE, ""))));

// 番号・日付・住所の形があるか。見出しの検査でも使う
export function formKind(text) {
  const half = standard(text);
  if (maskPhones(half) !== half) return "電話番号";
  if (half.replace(DATE, "") !== half) return "日付";
  if (half.replace(POSTAL, "") !== half) return "郵便番号";
  if (half.replace(ADDRESS, "") !== half) return "住所";
  return null;
}

// redact が置き換える形が残っていれば種類を返す。画面を通らない送信を入口で止めるために使う
export function personalKind(text) {
  const kind = formKind(text);
  if (kind) return kind;
  const half = standard(text);
  return maskNames(half) !== half ? "名前" : null;
}

// Claude に送る中身に本物の値が混ざっていないかを調べる。通しチェックで使う
// redact が残すと決めた形（地名として残す字など）では止めない
export function findLeaks(payload, realValues) {
  const sent = fold(typeof payload === "string" ? payload : JSON.stringify(payload));
  const half = toHalfWidth(sent);
  const leaks = [];
  for (const item of realValues) {
    const { value, kind } = typeof item === "string" ? { value: item } : item;
    if (!value || !value.trim()) continue;
    const forms = kind === "address" ? addressVariants(value) : variants(value);
    const hitText = forms.some((v) => formPattern(v, kind).test(sent) || formPattern(toHalfWidth(v), kind).test(half));
    const plain = toHalfWidth(value).trim();
    const d = plain.replace(/\D/g, "");
    const isNumber = d.length >= 7 && /^[\d\-‐()\s]+$/.test(plain);
    const hitDigits = isNumber && new RegExp(d.split("").join("[\\s\\-‐ー−().]{0,2}")).test(half);
    if (hitText || hitDigits) leaks.push(value);
  }
  return leaks;
}
