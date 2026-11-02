// 声メモや文の列を Claude に渡す前に、手元の名前・住所・電話番号と、それらしい形を置き換える
// 手元に無い人の名前は完全には見分けられない。続き柄で話す運用とあわせて使う
import { normalizeText, toHalfWidth, kataToHira, halfKanaToFull } from "./normalize.js";

const SEP = "[\\-‐‑–—―−ーｰ.．の・()（）\\s]";
const PHONE_LONG = new RegExp(`\\d(?:${SEP}*\\d){8,}`, "g");
const PHONE_LOCAL = new RegExp(`(?<![\\d:])\\d{2,4}${SEP}{1,2}\\d{4}(?![\\d:])`, "g");
const PHONE_KANJI = /[〇零一二三四五六七八九](?:[\-‐ーの・\s]*[〇零一二三四五六七八九]){8,}/g;
const DATE = /(?:(?:明治|大正|昭和|平成|令和|[MTSHR]\.?)\s*(?:\d{1,2}|元)|(?:19|20)\d{2})\s*[年.\/\-]\s*\d{1,2}\s*(?:[月.\/\-]\s*\d{1,2}\s*日?|月)/g;
const POSTAL = /〒\s*\d{3}/g;
const LOT_ADDRESS = /[都道府県市区町村字][^\s、。]{0,20}?\d+\s*(?:[-‐ー−]|番地?|丁目)\s*\d+/;

// 「さん」が付いても名前ではない言葉
const NOT_A_NAME = new Set([
  "本人", "緊急連絡先", "娘", "息子", "奥", "嫁", "孫", "母", "父", "兄", "姉", "弟", "妹", "夫", "妻", "旦那", "親", "親戚", "叔母", "伯母", "叔父", "伯父",
  "隣", "近所", "大家", "区長", "会長", "自治会長", "民生委員", "委員", "ケアマネ", "ヘルパー", "看護師", "職員", "担当", "運転手", "先生", "医者", "駐在",
]);
const NAME_LIKE = /[一-龥々ァ-ヶー]+(?=さん|様|さま|氏|ちゃん|くん)/g;
const isName = (word) => !NOT_A_NAME.has(word);

const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

function variants(value) {
  const text = normalizeText(value);
  const out = new Set([value.trim(), text, text.replace(/\s/g, "")]);
  for (const part of text.split(" ")) if (part.length >= 2) out.add(part);
  const hira = kataToHira(halfKanaToFull(text));
  for (const form of [hira, hiraToKata(hira)]) {
    out.add(form);
    out.add(form.replace(/\s/g, ""));
    for (const part of form.split(" ")) if (part.length >= 2) out.add(part);
  }
  out.delete("");
  return [...out];
}

// 住所は全部を言わないことが多いので、字から先と番地でも探す
function addressVariants(value) {
  const text = toHalfWidth(normalizeText(value));
  const out = new Set(variants(value));
  const tail = /字.*$/.exec(text)?.[0] ?? text.replace(/^.*[都道府県市区町村郡]/, "");
  for (const form of [tail, tail.replace(/\s/g, "")]) if (form.length >= 2) out.add(form);
  const lot = /(\d+)\s*[-‐ー−]\s*(\d+)(?:\s*[-‐ー−]\s*(\d+))?\s*$/.exec(text);
  if (lot) {
    const [, a, b] = lot;
    out.add(lot[0].trim());
    const area = tail.replace(lot[0], "").trim();
    for (const form of [`${a}番地${b}`, `${a}番${b}`, `${a}番${b}号`]) {
      out.add(form);
      if (area) out.add(`${area}${form}`);
    }
  }
  return [...out];
}

// どの形の名前や住所から置き換えても壊れないよう、長いものから置き換える
function replacements(known) {
  const pairs = [];
  for (const { value, alias, kind } of known) {
    if (!value) continue;
    for (const v of kind === "address" ? addressVariants(value) : variants(value)) pairs.push([v, alias]);
  }
  return pairs.sort(([a], [b]) => b.length - a.length);
}

export function redact(text, known = []) {
  let out = halfKanaToFull(normalizeText(text));
  for (const [from, alias] of replacements(known)) out = out.split(from).join(alias);
  return toHalfWidth(out)
    .replace(DATE, "[日付]")
    .replace(PHONE_KANJI, "[電話番号]")
    .replace(PHONE_LONG, "[電話番号]")
    .replace(PHONE_LOCAL, "[電話番号]")
    .replace(NAME_LIKE, (word) => (isName(word) ? "[お名前]" : word));
}

// 計画の文字すべてを置き換えて送る形にする。手で直した欄もここを通る
export function redactDeep(node, known = []) {
  if (typeof node === "string") return redact(node, known);
  if (Array.isArray(node)) return node.map((v) => redactDeep(v, known));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactDeep(v, known)]));
}

// それらしい値が文字にあれば種類を返す。サーバーの入口と、Claude の答えの検査で使う
export function personalKind(text) {
  const half = toHalfWidth(halfKanaToFull(String(text).normalize("NFKC")));
  const has = (re) => new RegExp(re.source, re.flags.replace("g", "")).test(half);
  if (has(PHONE_LONG) || has(PHONE_LOCAL) || has(PHONE_KANJI)) return "電話番号";
  if (has(DATE)) return "日付";
  if (has(POSTAL)) return "郵便番号";
  if (LOT_ADDRESS.test(half)) return "住所";
  if ((half.match(NAME_LIKE) ?? []).some(isName)) return "名前";
  return null;
}

// Claude に送る中身に本物の値が混ざっていないかを調べる。通しチェックで使う
export function findLeaks(payload, realValues) {
  const sent = typeof payload === "string" ? payload : JSON.stringify(payload);
  const half = toHalfWidth(sent);
  const digits = half.replace(/\D/g, "");
  const leaks = [];
  for (const value of realValues) {
    if (!value || !value.trim()) continue;
    const hitText = variants(value).some((v) => v.length >= 2 && (sent.includes(v) || half.includes(toHalfWidth(v))));
    const d = toHalfWidth(value).replace(/\D/g, "");
    const hitDigits = d.length >= 7 && /^[\d\-‐()\s]+$/.test(toHalfWidth(value).trim()) && digits.includes(d);
    if (hitText || hitDigits) leaks.push(value);
  }
  return leaks;
}
