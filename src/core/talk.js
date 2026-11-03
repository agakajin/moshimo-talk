// ふだんの話のきっかけはプログラムが選ぶ。AI を待たせない
const filled = (f) => f.status === "filled";

const TOPICS = [
  {
    id: "hazards",
    // 寝室が分かっていれば聞き直さない
    opener: (c) => (c.bedroom ? `${c.bedroom}で寝ていらっしゃるのですね。もしものときに、心配なことはありますか？` : "もしものときに、心配なことはありますか？"),
    done: (p) => filled(p.hazards.items),
    fills: ["hazards.items"],
  },
  { id: "place", opener: () => "逃げるとしたら、どこが思い浮かびますか？", done: (p) => filled(p.evacuation.place), fills: ["evacuation.place"] },
  { id: "means", opener: (c) => `${c.place ?? "そこ"}までは、何で行きますか？`, done: (p) => filled(p.evacuation.means), fills: ["evacuation.means"] },
  { id: "time", opener: () => "準備と移動に、どれくらいかかりそうですか？", done: (p) => filled(p.evacuation.moveMinutes), fills: ["evacuation.prepMinutes", "evacuation.moveMinutes"] },
  {
    id: "week",
    opener: (c) => (c.gaps?.length ? `${c.gaps.join("・")}の昼は、どう過ごしていますか？` : "1週間は、どう過ごしていますか？"),
    done: (p) => filled(p.timeBands) || filled(p.home.aloneHours),
    fills: ["home.aloneHours", "timeBands"],
  },
  { id: "neighbors", opener: () => "ご近所で、顔を知っている方はいますか？", done: (p) => p.helpers.length > 0, fills: ["helpers"] },
  { id: "contact", opener: () => "避難の知らせは、何で受けますか？", done: (p) => filled(p.contactMeans), fills: ["contactMeans"] },
  { id: "carry", opener: () => "薬や補聴器の電池は、どこに置いていますか？", done: (p) => filled(p.carry), fills: ["carry"] },
];

export function nextTopic(plan, { gaps = null, skipped = [] } = {}) {
  const context = { gaps, place: plan.evacuation.place.value, bedroom: plan.home.bedroom.value };
  const topic = TOPICS.find((t) => !t.done(plan) && !skipped.includes(t.id));
  return topic ? { id: topic.id, text: topic.opener(context), fills: topic.fills } : null;
}

// 頼みごとの紙に必ず入れる文。AI に作らせない
export const REQUEST_NOTE = "お願いできる範囲で大丈夫です。必ず来られるとは限りません。義務ではありません。";
