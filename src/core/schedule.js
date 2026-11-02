// 週間予定の文から、曜日と時間帯と種類だけを取り出す。事業所名は捨てる
import { normalizeText } from "./normalize.js";

const KINDS = ["デイサービス", "デイケア", "訪問介護", "訪問看護", "訪問リハビリ", "ショートステイ"];
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];
const WEEKDAYS = WEEK.slice(0, 5);

const pad = (t) => t.replace(/^(\d):/, "0$1:");

export function parseWeekly(raw) {
  const text = normalizeText(raw ?? "");
  if (text === "") return { items: [], unread: [] };
  const items = [];
  const unread = [];
  for (const part of text.split(/[;、\n]/).map((p) => p.trim()).filter(Boolean)) {
    const kind = KINDS.find((k) => part.includes(k));
    const days = part.match(/[月火水木金土日]+(?=\s*(曜日?)?\s*\d{1,2}:\d{2})/);
    const time = part.match(/(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})/);
    if (!kind || !days || !time) { unread.push(part); continue; }
    items.push({
      kind,
      days: WEEK.filter((d) => days[0].includes(d)),
      start: pad(time[1]),
      end: pad(time[2]),
    });
  }
  return { items, unread };
}

// 平日の昼に、サービスで誰かがそばにいない曜日
export function weekdaysWithoutService(items) {
  const covered = new Set(items.flatMap((i) => i.days));
  return WEEKDAYS.filter((d) => !covered.has(d));
}
