// 週間予定の文から、曜日と時間帯と種類だけを取り出す。事業所名は捨てる
// 曜日を増やして読むと、聞くべき空きの曜日が黙って消える。確かな形だけを読み、迷うものは読めない扱いにして人に見せる
import { normalizeText } from "./normalize.js";

const KINDS = ["デイサービス", "デイケア", "訪問介護", "訪問看護", "訪問リハビリ", "ショートステイ"];
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];
const WEEKDAYS = WEEK.slice(0, 5);

const pad = (t) => t.replace(/^(\d):/, "0$1:");

// 毎週ではない言い方、休みや終わりの言い方。「第2火曜」「水曜を除く」「3月で終了」
const NOT_WEEKLY = /第|隔|[月週]\s*\d|\d\s*[月日]|休|除|以外|中止|終了|のみ|祝|毎月|今月|来月|先月|おき|交互|不定期|臨時/;
const DAY = "[月火水木金土日]";
// 漢字、数字、仮名に続く字（三日月、4月、みか月）は曜日に数えない
const NOT_AFTER = "(?<![\\p{Script=Han}\\dぁ-ゖ])";
const DAY_RUN = new RegExp(`${NOT_AFTER}(?:${DAY}(?:曜日?)?[\\s・、,/と~\\-ー]*|から)+$`, "u");
const DAY_RANGE = new RegExp(`(${DAY})\\s*(?:[~\\-ー]|から)\\s*(${DAY})`, "g");
// 読んだ曜日の前に、別の曜日の列が残っている（「午前:月 午後:木」）
const OTHER_DAYS = new RegExp(`${NOT_AFTER}${DAY}(?:曜日?)?(?:[\\s・、,:/]|${DAY})`, "u");

function daysBefore(text, kind) {
  // 種類の語と「毎週」は、曜日の前の区切りとして扱う
  const before = text.replace(kind, " ").replace(/毎週/g, " ").replace(/[−―‐–—〜]/g, "-").trim();
  if (/(?:^|\s)毎日$/.test(before)) return WEEK;
  if (/(?:^|\s)平日$/.test(before)) return WEEKDAYS;
  const run = before.match(DAY_RUN);
  if (!run || !new RegExp(DAY).test(run[0][0])) return [];
  if (OTHER_DAYS.test(before.slice(0, run.index))) return [];
  // 「月-水-金」は範囲か列挙か分からない。読めない扱いにする
  if ((run[0].match(/[~\-ー]|から/g)?.length ?? 0) > 1) return [];
  const plain = run[0].replace(/曜日?/g, "").replace(DAY_RANGE, (_, from, to) => WEEK.slice(WEEK.indexOf(from), WEEK.indexOf(to) + 1).join(""));
  return WEEK.filter((d) => plain.includes(d));
}

const minutesOf = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h <= 24 && m < 60 ? h * 60 + m : null;
};

export function parseWeekly(raw) {
  // 「9時〜16時」も時刻として読む
  const text = normalizeText(raw ?? "").replace(/(\d{1,2})時半/g, "$1:30").replace(/(\d{1,2})時(\d{2})分?/g, "$1:$2").replace(/(\d{1,2})時/g, "$1:00");
  if (text === "") return { items: [], unread: [] };
  const items = [];
  const unread = [];
  // 「月、水、金」の読点では切らない
  for (const part of text.split(/[;\n]|、(?![月火水木金土日](?:曜日?)?(?:[、・\s]|\d))/).map((p) => p.trim()).filter(Boolean)) {
    const kind = KINDS.find((k) => part.includes(k));
    const time = part.match(/(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})/);
    // 1つの区切りに時間帯が2つあると、2つ目を黙って落とすので、読めない扱いにする
    const ranges = part.match(/\d{1,2}:\d{2}\s*[-~〜]\s*\d{1,2}:\d{2}/g)?.length ?? 0;
    const inOrder = time && minutesOf(time[1]) !== null && minutesOf(time[2]) !== null && minutesOf(time[1]) < minutesOf(time[2]);
    const days = kind && inOrder && ranges === 1 && !NOT_WEEKLY.test(part.replace(/\d{1,2}:\d{2}/g, " ")) ? daysBefore(part.slice(0, time.index), kind) : [];
    if (days.length === 0) { unread.push(part); continue; }
    items.push({ kind, days, start: pad(time[1]), end: pad(time[2]) });
  }
  return { items, unread };
}

// 平日の昼に、サービスで誰かがそばにいない曜日
export function weekdaysWithoutService(items) {
  const covered = new Set(items.flatMap((i) => i.days));
  return WEEKDAYS.filter((d) => !covered.has(d));
}
