// Claude に渡す前に、本物の値を記号に置き換える。対応表は手元から出さない
import { normalizeDate, normalizePhone, normalizePostal, normalizeText, toHalfWidth } from "./normalize.js";
import { formKind, personalKind } from "./redact.js";

// 見出しに入ると指示文の行に見える文字。読むときに断る
export const CONTROL = /[\p{Cc}\u2028\u2029]/u;

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
