// Claude につなぐまでの仮の書き取りと点検。台本の言葉にだけ反応する。画面に「仮の答え」と必ず出す
import { parseMinutes } from "../core/normalize.js";

export function mockScribe(memo) {
  const updates = [];
  const set = (path, value) => updates.push({ path, value });
  if (/崖|土砂/.test(memo)) set("hazards.items", "土砂");
  if (/津波/.test(memo)) set("hazards.items", "津波");
  const bedroom = memo.match(/([^。、]*の部屋)で寝ている/);
  if (bedroom) set("home.bedroom", bedroom[1]);
  if (/火.?木/.test(memo)) set("home.aloneHours", "火・木の日中");
  if (/ほかの災害は心配していない/.test(memo)) set("hazards.noOthers", true);
  if (/公民館/.test(memo)) set("evacuation.place", "ハッカ村公民館");
  if (/小学校/.test(memo)) set("evacuation.place", "ハッカ村小学校");
  if (/車いす/.test(memo)) set("evacuation.means", "車いす");
  if (/階段|石段|一段/.test(memo)) set("evacuation.route", memo);
  const prep = memo.match(/準備に?(\d+)分/);
  if (prep) set("evacuation.prepMinutes", prep[1]);
  const move = memo.match(/(?:公民館まで|小学校まで|移動に?)(\d+)分/);
  if (move) set("evacuation.moveMinutes", move[1]);
  if (/の昼|デイ|夜は/.test(memo) && !/隣/.test(memo)) set("timeBands", memo);
  if (/隣/.test(memo)) {
    updates.push({
      path: "helpers.add",
      value: { alias: "隣の人", awayWeekdayDaytime: /平日の昼.*(村の外|いない|仕事)/.test(memo), asked: !/頼んでいない/.test(memo) },
    });
  }
  if (/固定電話/.test(memo)) set("contactMeans", /だけ|のみ/.test(memo) ? "固定電話のみ" : "固定電話");
  if (/薬|電池/.test(memo) && /袋|持って/.test(memo)) {
    const bag = memo.match(/^(.+?)を、?(.+?)に/);
    set("carry", bag ? `${bag[1]}（${bag[2]}）` : memo.split("。")[0]);
  }
  if (/補聴器/.test(memo)) set("considerations.items", "補聴器");
  if (/酸素/.test(memo)) set("considerations.items", "車いすと医療機器（在宅酸素）");
  if (/ほかに配慮することはない/.test(memo)) set("considerations.noOthers", true);
  return updates;
}

const filled = (f) => f.status === "filled";

export function mockCheck({ plan, gaps, targetMinutes, yardstick }) {
  const findings = [];
  const add = (id, label, text, extra = {}) => findings.push({ id, yardstick: label, text, ...extra });

  if (yardstick && filled(plan.evacuation.means) && !filled(plan.evacuation.route)) {
    add("slope-route", yardstick.label, "手段と、家のまわりの道が合っているか、まだ聞けていません。", { interrupt: true, opener: yardstick.opener });
  }
  if (filled(plan.evacuation.route)) {
    const steps = /石段/.test(plan.home.hazardNote?.value ?? "") ? "石段" : "階段";
    add("slope-request", yardstick?.label ?? "坂・階段", "階段を一人で降りられないようです。", plan.helpers.length || steps === "石段" ? { request: `${steps}を降りるときだけ、手を貸してください` } : {});
  }
  if (plan.contactMeans.value === "固定電話のみ") {
    add("single-contact", "一本足", "知らせを受ける手段が固定電話だけです。", plan.helpers.length ? { request: "雨の夜に、電話を1本" } : {});
  }
  if (gaps?.length && plan.helpers.some((h) => h.awayWeekdayDaytime)) {
    add("daytime-gap", "時間帯", `${gaps.join("・")}の昼は、隣の人がいません。`, { request: "雨の予報の日の昼に、電話を1本（娘さんへ）" });
  }
  if (/酸素/.test(plan.considerations.items.value ?? "") && !filled(plan.carry)) {
    add("carry-power", "持ち出し", "酸素の電源とボンベを持って出る段取りを、まだ聞けていません。");
  }
  if (/住宅|建物/.test(plan.evacuation.route.value ?? "") && plan.helpers.length === 0) {
    add("no-helper", "最低ライン", "手伝う人はまだ決まっていません。今日決めなくて大丈夫です。", { request: "同じ建物の方に、あいさつを一度" });
  }
  const prep = parseMinutes(plan.evacuation.prepMinutes.value);
  const move = parseMinutes(plan.evacuation.moveMinutes.value);
  if (filled(plan.evacuation.prepMinutes) && filled(plan.evacuation.moveMinutes) && prep + move > targetMinutes) {
    add("in-time", "間に合うか", `準備と移動で${prep + move}分かかり、目安の${targetMinutes}分を超えます。`);
  }
  return findings;
}
