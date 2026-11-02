// 待っている間も話を止めない。順番と、古い答えの扱いを確かめる
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { applyUpdates, importRow, serviceGaps } from "../src/core/plan.js";
import { nextTopic } from "../src/core/talk.js";
import { createLatest, createQueue } from "../src/core/work.js";
import { mockCheck, mockScribe } from "../src/server/mock-talk.js";

const later = () => new Promise((resolve) => setTimeout(resolve, 5));
const read = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url));

test("声メモは入れた順に処理し、失敗しても次へ進む", async () => {
  const queue = createQueue();
  const done = [];
  queue.add(async () => { await later(); done.push(1); });
  queue.add(async () => { done.push(2); throw new Error("失敗"); }).catch(() => {});
  queue.add(async () => { done.push(3); });
  await queue.idle();
  assert.deepEqual(done, [1, 2, 3]);
});

test("点検中に頼まれたら、前の答えを捨てて、最後にもう一度だけ動く", async () => {
  const runs = [];
  const latest = createLatest(async (isStale) => {
    await later();
    runs.push(isStale());
  });
  latest.request();
  latest.request();
  latest.request();
  await latest.idle();
  assert.deepEqual(runs, [true, false]);
});

test("点検が失敗しても、次の頼みで動ける", async () => {
  let calls = 0;
  const latest = createLatest(async () => {
    calls += 1;
    if (calls === 1) throw new Error("失敗");
  });
  await latest.request().catch(() => {});
  await latest.request();
  assert.equal(calls, 2);
});

function yoshikawa() {
  const table = parseCsv(decodeCsv(read("keahakka_yoshikawa.csv")));
  const { plan, identity } = importRow({ headers: table.headers, row: table.rows[0], mapping: JSON.parse(read("keahakka.mapping.json")) });
  JSON.parse(read("yoshikawa.script.json")).forEach((memo, i) => applyUpdates(plan, mockScribe(memo), i + 1));
  return { plan, identity };
}

test("𠮷川さんの台本：予定が空でも話で埋まり、手伝う人が未定のまま進む", () => {
  const { plan, identity } = yoshikawa();
  assert.equal(identity["self.name"], "𠮷川 正一");
  assert.equal(serviceGaps(plan), null);
  assert.equal(plan.hazards.items.value, "津波");
  assert.equal(plan.evacuation.place.value, "ハッカ村小学校");
  assert.equal(plan.evacuation.means.value, "車いす");
  assert.equal(plan.helpers.length, 0);
  assert.ok(nextTopic(plan, {}), "聞けていない話が残る");
});

test("𠮷川さんの点検：階段と持ち出しに当たり、岡野さんの話を持ち込まない", () => {
  const { plan } = yoshikawa();
  const yard = { label: "坂・階段・狭い道", opener: "家の前の階段は、どうやって降りますか？" };
  const findings = mockCheck({ plan, gaps: null, targetMinutes: 60, yardstick: yard });
  const text = JSON.stringify(findings);
  assert.ok(findings.some((f) => f.yardstick === "持ち出し" && /ボンベ/.test(f.text)));
  assert.ok(findings.some((f) => f.request === "同じ建物の方に、あいさつを一度"));
  assert.ok(!/石段|隣の人|固定電話/.test(text), text);
});
