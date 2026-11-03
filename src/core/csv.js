// ブラウザでも動くように、Node の機能に頼らない

export function decodeCsv(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export function parseCsv(text) {
  const records = [];
  let doubtful = false;
  let record = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') {
        quoted = false;
        // 閉じ忘れが2行で対になると、2行が1つの値になる。改行とカンマの両方がある値は確かめてもらう
        if (cell.includes("\n") && cell.includes(",")) doubtful = true;
      }
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { record.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(cell); cell = "";
      records.push(record); record = [];
    } else cell += c;
  }
  if (cell !== "" || record.length > 0) { record.push(cell); records.push(record); }
  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ""));
  const [first = [], ...rows] = nonEmpty;
  const headers = first.map((h) => h.trim());
  // 行末のカンマでできた空の見出しは列に数えない
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();
  // 閉じていない引用符は、次の行まで1つの値に吸い込む
  return quoted || doubtful ? { headers, rows, unclosed: true } : { headers, rows };
}
