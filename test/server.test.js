import test from "node:test";
import assert from "node:assert/strict";
import { validateColumnsPayload } from "../src/server/validate.js";
import { mockReadColumns } from "../src/server/mock-reader.js";

const ok = { columns: [{ header: "利用者名", withheld: false, samples: ["文字列1"] }, { header: "備考", withheld: true, samples: [] }] };

test("記号だけの中身は通す", () => {
  assert.deepEqual(validateColumnsPayload(ok), []);
});

test("本物の値らしいものが混ざれば止める", () => {
  const bad = { columns: [{ header: "利用者名", withheld: false, samples: ["岡野 ハル"] }] };
  assert.equal(validateColumnsPayload(bad).length, 1);
  const phone = { columns: [{ header: "連絡先", withheld: false, samples: ["000-0000-0001"] }] };
  assert.equal(validateColumnsPayload(phone).length, 1);
});

test("決まった項目以外や、送らない列の値も止める", () => {
  assert.ok(validateColumnsPayload({ ...ok, memo: "岡野" }).length > 0);
  assert.ok(validateColumnsPayload({ columns: [{ header: "備考", withheld: true, samples: ["文字列1"] }] }).length > 0);
  assert.ok(validateColumnsPayload({ columns: [{ header: "a", withheld: false, samples: [], memo: "x" }] }).length > 0);
  assert.ok(validateColumnsPayload({}).length > 0);
});

test("仮の答えは、分からない見出しを推測しない", () => {
  const results = mockReadColumns({ columns: [{ header: "利用者名" }, { header: "ｺｰﾄﾞX" }] });
  assert.equal(results[0].target, "self.name");
  assert.equal(results[1].target, "unknown");
});
