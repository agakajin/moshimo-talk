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
  [/階段/, "care.stairs"],
  [/聞こえ|聴覚/, "care.hearing"],
  [/普段.*部屋|居室/, "home.usualRoom"],
  [/寝室|就寝/, "home.bedroom"],
  [/同居|世帯|家族/, "care.household"],
  [/危険|環境/, "home.hazardNote"],
  [/歩行|移動|ADL/i, "care.mobility"],
  [/備考|メモ|特記/, "notes"],
];

// 出口の様式。順番に意味がある（緊急連絡先を先に見る）
const OUTPUT_RULES = [
  [/管理番号|整理番号/, "meta.serial"],
  [/作成日|記入日/, "meta.createdOn"],
  [/カナ|かな|ﾌﾘｶﾞﾅ/, "self.kana"],
  [/緊急.*(電話|TEL)/i, "emergency.phone"],
  [/緊急.*(氏名|名前)/, "emergency.name"],
  [/(支援者|同行者).*(電話|TEL)/i, "helper1.phone"],
  [/支援者.*続柄/, "helper1.relation"],
  [/支援者|同行者/, "helper1.name"],
  [/氏名|名前/, "self.name"],
  [/生年月日/, "self.birth"],
  [/性別/, "self.gender"],
  [/住所/, "self.address"],
  [/自治会|町内会/, "home.community"],
  [/電話|TEL/i, "self.phone"],
  [/避難先|避難場所/, "evacuation.place"],
  [/避難方法/, "evacuation.summary"],
  [/手段/, "evacuation.means"],
  [/所要/, "evacuation.minutes"],
  [/配慮/, "considerations.all"],
  [/災害|リスク/, "hazards.all"],
  [/介護度/, "care.level"],
  [/寝室/, "home.bedroom"],
  [/部屋/, "home.usualRoom"],
  [/ひとり|一人/, "home.aloneHours"],
  [/住居|居住|階/, "new"],
];

export function mockReadColumns({ columns, kind }) {
  return columns.map(({ header }) => {
    const hit = (kind === "output" ? OUTPUT_RULES : RULES).find(([re]) => re.test(header));
    return { header, target: hit ? hit[1] : "unknown", confidence: hit ? "medium" : "low" };
  });
}
