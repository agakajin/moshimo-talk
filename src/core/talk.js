// ふだんの話のきっかけはプログラムが選ぶ。AI を待たせない
const filled = (f) => f.status === "filled";

const TOPICS = [
  { id: "hazards", opener: () => "大雨の夜は、いつもどの部屋で寝ていますか？", done: (p) => filled(p.hazards.items) },
  { id: "place", opener: () => "逃げるとしたら、どこが思い浮かびますか？", done: (p) => filled(p.evacuation.place) },
  { id: "means", opener: (c) => `${c.place ?? "そこ"}までは、何で行きますか？`, done: (p) => filled(p.evacuation.means) },
  { id: "time", opener: () => "準備と移動に、どれくらいかかりそうですか？", done: (p) => filled(p.evacuation.moveMinutes) },
  {
    id: "week",
    opener: (c) => (c.gaps?.length ? `${c.gaps.join("・")}の昼は、どう過ごしていますか？` : "1週間は、どう過ごしていますか？"),
    done: (p) => filled(p.timeBands),
  },
  { id: "neighbors", opener: () => "ご近所で、顔を知っている方はいますか？", done: (p) => p.helpers.length > 0 },
  { id: "contact", opener: () => "避難の知らせは、何で受けますか？", done: (p) => filled(p.contactMeans) },
  { id: "carry", opener: () => "薬や補聴器の電池は、どこに置いていますか？", done: (p) => filled(p.carry) },
];

export function nextTopic(plan, { gaps = null, skipped = [] } = {}) {
  const context = { gaps, place: plan.evacuation.place.value };
  const topic = TOPICS.find((t) => !t.done(plan) && !skipped.includes(t.id));
  return topic ? { id: topic.id, text: topic.opener(context) } : null;
}

// 頼みごとの紙に必ず入れる文。AI に作らせない
export const REQUEST_NOTE = "お願いできる範囲で大丈夫です。必ず来られるとは限りません。義務ではありません。";
