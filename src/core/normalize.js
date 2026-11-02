// 中では1つの形にそろえる。氏名だけは本人の名前を変えないよう手を入れない

export function toHalfWidth(s) {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

export function halfKanaToFull(s) {
  return s.replace(/[｡-ﾟ]+/g, (m) => m.normalize("NFKC"));
}

export function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function collapseSpaces(s) {
  return s.trim().replace(/\s+/g, " ");
}

export function normalizeText(s) {
  return collapseSpaces(halfKanaToFull(toHalfWidth(s)));
}

export function normalizeName(s) {
  return s.trim();
}

export function normalizeKana(s) {
  return collapseSpaces(kataToHira(halfKanaToFull(toHalfWidth(s))));
}

export function normalizePhone(s) {
  return toHalfWidth(s).replace(/\D/g, "");
}

export function normalizePostal(s) {
  const digits = toHalfWidth(s).replace(/\D/g, "");
  return digits.length === 7 ? digits : null;
}

export function normalizeAddress(s) {
  let t = normalizeText(s);
  // 長音は数字にはさまれた時だけハイフンにする（建物名のカタカナを壊さない）
  let prev;
  do {
    prev = t;
    t = t.replace(/(\d)[ー‐―−ｰ-](\d)/g, "$1-$2");
  } while (t !== prev);
  return t;
}

const ERAS = {
  M: { name: "明治", base: 1867, from: "1868-01-25", to: "1912-07-29" },
  T: { name: "大正", base: 1911, from: "1912-07-30", to: "1926-12-24" },
  S: { name: "昭和", base: 1925, from: "1926-12-25", to: "1989-01-07" },
  H: { name: "平成", base: 1988, from: "1989-01-08", to: "2019-04-30" },
  R: { name: "令和", base: 2018, from: "2019-05-01", to: "9999-12-31" },
};

function isoDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normalizeDate(s) {
  const t = normalizeText(s);
  const west = t.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/);
  if (west) return isoDate(+west[1], +west[2], +west[3]);
  const era = t.match(/^(明治|大正|昭和|平成|令和|[MTSHR])\.?\s*(元|\d{1,2})[年.\/\-](\d{1,2})[月.\/\-](\d{1,2})日?$/);
  if (!era) return null;
  const info = Object.values(ERAS).find((e) => e.name === era[1]) ?? ERAS[era[1]];
  const year = info.base + (era[2] === "元" ? 1 : +era[2]);
  const iso = isoDate(year, +era[3], +era[4]);
  if (!iso || iso < info.from || iso > info.to) return null;
  return iso;
}

function kanjiNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const unit = { 十: 10, 百: 100 };
  const digit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const c of s) {
    if (c in digit) current = digit[c];
    else { total += (current || 1) * unit[c]; current = 0; }
  }
  return total + current;
}

const AMOUNT = "[0-9一二三四五六七八九十百]+";

// 文に出てくる時間を、すべて分で返す（「1時間半」は 90、「準備に15分、移動に30分」は 15 と 30）
export function minutesIn(text) {
  const s = String(text ?? "").normalize("NFKC");
  const found = [];
  const rest = s.replace(new RegExp(`(${AMOUNT})時間(半)?(?:(${AMOUNT})分)?`, "g"), (_, h, half, m) => {
    found.push(kanjiNumber(h) * 60 + (half ? 30 : 0) + (m ? kanjiNumber(m) : 0));
    return " ";
  }).replace(/半時間/g, () => { found.push(30); return " "; });
  for (const [, m] of rest.matchAll(new RegExp(`(${AMOUNT})分`, "g"))) found.push(kanjiNumber(m));
  return found;
}

// 欄の値を分の数字にする。読めなければ null（少なく見せないため、0 にしない）
export function parseMinutes(value) {
  const s = String(value ?? "").normalize("NFKC").trim();
  if (new RegExp(`^(?:約|およそ)?(${AMOUNT})(?:くらい|ぐらい)?$`).test(s)) return kanjiNumber(s.replace(/\D*?([0-9一二三四五六七八九十百]+).*/, "$1"));
  const found = minutesIn(s);
  return found.length === 1 ? found[0] : null;
}
