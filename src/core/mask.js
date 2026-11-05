// Claude に渡す前に、本物の値を記号に置き換える。対応表は手元から出さない
import { normalizeDate, normalizePhone, normalizePostal, normalizeText, toHalfWidth } from "./normalize.js";
import { findLeaks, formKind, personalKind } from "./redact.js";

// 見出しに入ると指示文の行に見える文字と、プログラムの部品と同じ名前。読むときに断る
export const CONTROL = /[\p{Cc}\u2028\u2029]|^(?:__proto__|constructor|prototype|toString|valueOf|hasOwnProperty|isPrototypeOf)$/u;

const WITHHELD_HEADER = /備考|メモ|特記|自由記述|コメント/;

export function classifyValue(raw) {
  const value = raw.trim();
  if (value === "") return "空";
  const half = toHalfWidth(value);
  if (normalizeDate(value)) return "日付";
  if (/^[\d\-‐ー()+\s]+$/.test(half)) {
    if (/^\d{3}\s*[\-‐ー]\s*\d{4}$/.test(half) && normalizePostal(value)) return "郵便番号";
    const n = normalizePhone(value).length;
    if (n >= 10 && n <= 11) return "電話番号";
  }
  if (/[都道府県市区町村字].*\d/.test(half)) return "住所";
  return "文字列";
}

// 見出しに値が入っているか。見出しの無い CSV では、1人目の情報が見出しに来る
const HEADER_WORD = /氏名|名前|連絡|電話|住所|番号|年月日|性別|状態|予定|区分|認定|介護|歩行|階段|同居|家族|備考|担当|緊急|週間|サービス|部屋|寝室|聞こえ|フリガナ|ふりがな|カナ/;
export function looksLikeValue(header) {
  const text = normalizeText(header);
  if (formKind(text)) return true;
  // 見出しのない CSV では、介護度や性別の値が見出しに来る
  if (/^(?:要介護[1-5１-５]|要支援[12１２]|男|女|男性|女性)$/.test(text)) return true;
  return /^[一-龥々ァ-ヶぁ-ゖー]+ [一-龥々ァ-ヶぁ-ゖー]+$/.test(text) && !HEADER_WORD.test(text);
}

export function maskTable({ headers, rows }, { sampleRows = 5 } = {}) {
  const counters = new Map();
  const symbolOf = new Map();
  const symbols = new Map();

  const toSymbol = (raw) => {
    const type = classifyValue(raw);
    if (type === "空") return "空";
    const key = `${type}:${normalizeText(raw)}`;
    if (!symbolOf.has(key)) {
      const n = (counters.get(type) ?? 0) + 1;
      counters.set(type, n);
      const symbol = `${type}${n}`;
      symbolOf.set(key, symbol);
      symbols.set(symbol, raw);
    }
    return symbolOf.get(key);
  };

  const cellSet = new Set(rows.flat().map((v) => normalizeText(v)).filter(Boolean));
  const columns = headers.map((header, col) => {
    if (WITHHELD_HEADER.test(header)) return { header, withheld: true, suspectHeader: looksLikeValue(header) || Boolean(personalKind(header)) || CONTROL.test(header), samples: [] };
    return {
      header,
      withheld: false,
      // 「同居」「歩行」のように列の値と同じ見出しはあるので、見出しの言葉なら通す
      suspectHeader: (cellSet.has(normalizeText(header)) && !HEADER_WORD.test(header)) || looksLikeValue(header) || Boolean(personalKind(header)) || CONTROL.test(header),
      samples: rows.slice(0, sampleRows).map((row) => toSymbol(row[col] ?? "")),
    };
  });

  return {
    // payload だけを Claude に送る。symbols は画面の中だけで使う
    payload: {
      columns: columns.map(({ header, withheld, samples }) => ({ header, withheld, samples })),
    },
    suspectHeaders: columns.filter((c) => c.suspectHeader).map((c) => c.header),
    symbols,
  };
}

// 介護の記録によく出る、人の名前にはならない言葉
// 頭か終わりにあるときだけ除く。「毛利用子」のように途中に同じ字がある名前を壊さない
const CARE_WORDS = /^(?:要介護|介護度|介護|要支援|支援|介助|看護|利用|歩行|階段|昇降|移動|服薬|聴力|視力|認知症|認知|通所|訪問|入浴|排泄|補聴器|同居|独居|家族|世帯|状態|状況|予定|区分|必要|不要|生活|自立|能力|環境|危険|段差|寝室|部屋|自宅|週間|サービス|災害|避難|近隣)+|(?:要介護|介護度|介護|要支援|支援|介助|看護|利用|歩行|階段|昇降|移動|服薬|聴力|視力|認知症|認知|通所|訪問|入浴|排泄|補聴器|同居|独居|家族|世帯|状態|状況|予定|区分|必要|不要|生活|自立|能力|環境|危険|段差|寝室|部屋|自宅|週間|サービス|災害|避難|近隣)+$/g;
const RELATION = /^(?:長男|次男|三男|長女|次女|三女)$/;
// 名前の列に入っていても、名前ではない値
const COMMON_VALUE = new RegExp(`^(?:${CARE_WORDS.source.slice(4, CARE_WORDS.source.indexOf(")+|"))}|本人|ご本人|なし|あり|不明)+$`);
const CARE_WORDS_EN = /(?<![a-z])(?:services?|weekly|days?|status|level|notes?)(?![a-z])/gi;
// 名前が入りそうな列。ここの値からは言葉を除かない
const PERSON_HEADER = /氏名|名前|なまえ|かな|がな|カナ|ｶﾅ|キーパーソン|キーマン|KP|介護者|連絡先|担当|ケアマネ|主治医|かかりつけ|医師|本人|利用者|対象者|被保険者|世帯主|後見人|配偶者|同居者|支援者|民生委員|name|contact|person|kana/i;

// 見出しに本物の値が残っていないかを、すべての列の値で調べる。名字だけ残っていても止める
// 「服薬」列の「服薬あり」のように、ふつうの言葉が見出しと重なるのは漏れではないので、値からその言葉を除いて照合する
// 名前を壊さないよう、見出しは変えない。名前の列の値と、空白で分かれた値（姓 名の形）からは、日本語の言葉を除かない
export function findHeaderLeaks({ headers, rows }, payload) {
  const text = payload.columns.map((c) => c.header).join(" / ");
  const leaks = new Set();
  for (const row of rows) {
    row.forEach((raw, col) => {
      const value = String(raw ?? "");
      const header = String(headers[col] ?? "");
      // 「避難の必要性」列の「必要」のように、自分の列の見出しの中にある値は漏れではない
      // 名前の列は、見出しと同じ値のときだけ外す（「氏名（岡野）」の「岡野」は見つける）
      if (!PERSON_HEADER.test(header) && header.includes(value.trim())) return;
      // 「家族」「本人」「訪問介護」のように、ふつうの言葉だけでできた値は名前ではない
      if (COMMON_VALUE.test(value.trim())) return;
      if (RELATION.test(value.trim())) return;
      let check = value;
      if (!PERSON_HEADER.test(header)) {
        check = value.replace(CARE_WORDS_EN, " ");
        if (!/\s/.test(value.trim())) check = check.replace(CARE_WORDS, " ");
      }
      const type = classifyValue(value);
      // 住所は字名と番地でも、電話は下4桁でも探す
      const item = type === "住所" ? { value, kind: "address" } : check;
      const lastDigits = type === "電話番号" ? normalizePhone(value).slice(-4) : "";
      // 「長女・山田」「山田（長女）」のように区切られた名前は、区切りごとにも探す
      const pieces = PERSON_HEADER.test(header) ? value.split(/[・()（）、,/]+/).map((p) => p.trim()).filter((p) => p && p !== value.trim() && !COMMON_VALUE.test(p) && !RELATION.test(p)) : [];
      if (findLeaks(text, [item, ...pieces]).length > 0 || (lastDigits && new RegExp(`(?<!\\d)${lastDigits}(?!\\d)`).test(toHalfWidth(text)))) leaks.add(value);
    });
  }
  return [...leaks];
}
