// Claude につなぐまでの仮の答え。見出しの言葉だけで判定する。画面にも「仮の答え」と必ず出す
const RULES = [
  [/ﾌﾘｶﾞﾅ|フリガナ|ふりがな|カナ/, "self.kana"],
  [/緊急.*(TEL|電話|連絡先電話)/i, "emergency.phone"],
  [/緊急.*(氏名|名前)/, "emergency.name"],
  [/利用者名|氏名|名前/, "self.name"],
  [/生年月日|誕生/, "self.birth"],
  [/性別/, "self.gender"],
  [/〒|郵便/, "self.postal"],
  [/住所/, "self.address"],
  [/連絡先|電話|TEL/i, "self.phone"],
  [/介護度|要介護|認定/, "care.level"],
  [/週間|予定|サービス/, "care.weekly"],
  [/歩行|移動|ADL/i, "care.mobility"],
  [/備考|メモ|特記/, "notes"],
];

export function mockReadColumns({ columns }) {
  return columns.map(({ header }) => {
    const hit = RULES.find(([re]) => re.test(header));
    return { header, target: hit ? hit[1] : "unknown", confidence: hit ? "medium" : "low" };
  });
}
