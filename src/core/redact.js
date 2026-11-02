// 声メモや文の列を Claude に渡す前に、手元の名前・住所・電話番号を置き換える
import { normalizeText, toHalfWidth, kataToHira, halfKanaToFull } from "./normalize.js";

const PHONE_LIKE = /\d[\d\-‐()\s]{7,}\d/g;

function variants(value) {
  const text = normalizeText(value);
  const out = new Set([value.trim(), text, text.replace(/\s/g, "")]);
  for (const part of text.split(" ")) if (part.length >= 2) out.add(part);
  const hira = kataToHira(halfKanaToFull(text));
  out.add(hira);
  for (const part of hira.split(" ")) if (part.length >= 2) out.add(part);
  out.delete("");
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(text, known = []) {
  let out = normalizeText(text);
  for (const { value, alias } of known) {
    if (!value) continue;
    for (const v of variants(value)) out = out.split(v).join(alias);
  }
  return toHalfWidth(out).replace(PHONE_LIKE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[電話番号]" : m));
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
