# 架空データのファイルを作る。Shift_JIS と UTF-8 の両方を試すために、文字コードを分けて書き出す
import json
from pathlib import Path

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
SAMPLES.mkdir(exist_ok=True)

okano = [
    ["利用者名", "ﾌﾘｶﾞﾅ", "生年月日", "性別", "〒", "住所", "連絡先", "介護度", "週間予定", "緊急連絡先氏名", "緊急連絡先TEL", "歩行", "階段", "聞こえ", "普段の部屋", "寝室", "同居", "危険個所", "備考"],
    ["岡野 ハル", "ｵｶﾉ ﾊﾙ", "昭和14年4月12日", "女", "０００－０００１", "ハッカ村字ミドリ　１２０３ー５", "0000-00-1234", "要介護1", "デイサービスはっか 月水金 9:00-16:00", "平井 ユキ", "000-0000-0001", "杖歩行。長距離は車いす", "一人では難しい", "右耳に補聴器", "居間", "家の裏の部屋", "なし", "家の前に石段、裏に崖", "娘さんはミント市在住"],
]
yoshikawa = [
    ["利用者名", "ﾌﾘｶﾞﾅ", "生年月日", "性別", "住所", "連絡先", "介護度", "週間予定", "備考"],
    ["𠮷川 正一", "ﾖｼｶﾜ ｼｮｳｲﾁ", "1944/1/7", "男", "ハッカ村字ミナト　２－３－４　村営みなと住宅２０１", "（０００）００００－０００２", "要介護3", "", "𠮷川 誠さん（息子）がミント市"],
]


def to_csv(rows):
    return "".join(",".join(row) + "\r\n" for row in rows)


(SAMPLES / "keahakka_okano.csv").write_bytes(to_csv(okano).encode("cp932"))
(SAMPLES / "keahakka_yoshikawa.csv").write_bytes(("﻿" + to_csv(yoshikawa)).encode("utf-8"))

mapping = {
    "利用者名": "self.name",
    "ﾌﾘｶﾞﾅ": "self.kana",
    "生年月日": "self.birth",
    "性別": "self.gender",
    "〒": "self.postal",
    "住所": "self.address",
    "連絡先": "self.phone",
    "介護度": "care.level",
    "週間予定": "care.weekly",
    "緊急連絡先氏名": "emergency.name",
    "緊急連絡先TEL": "emergency.phone",
    "歩行": "care.mobility",
    "階段": "care.stairs",
    "聞こえ": "care.hearing",
    "普段の部屋": "home.usualRoom",
    "寝室": "home.bedroom",
    "同居": "care.household",
    "危険個所": "home.hazardNote",
    "備考": "notes",
}

config = {
    "name": "ハッカ村",
    "kana": "はっかそん",
    "fictional": True,
    "encoding": "utf-8",
    "blankValue": "未決定",
    "evacuationTargetMinutes": 60,
    "evacuationTargetNote": "デモ用の値。公的な基準ではない",
    "columns": ["管理番号", "氏名", "ふりがな", "生年月日", "性別", "住所", "自治会名", "普段いる部屋", "寝室の場所", "ひとりになる時間帯", "電話番号", "携帯電話", "避難場所", "避難支援者1氏名", "避難支援者1続柄", "避難支援者1電話", "避難支援者2氏名", "避難支援者2続柄", "避難支援者2電話", "緊急連絡先1氏名", "緊急連絡先1電話", "避難時の配慮事項", "要介護度", "自宅の災害リスク", "避難方法", "特記事項", "作成日"],
    "alwaysColumns": ["管理番号", "氏名", "ふりがな", "生年月日", "性別", "住所", "自治会名", "作成日"],
    "neverColumns": ["特記事項"],
    "consentGroups": {
        "contact": {"label": "連絡先", "columns": ["電話番号", "携帯電話", "緊急連絡先1氏名", "緊急連絡先1電話"]},
        "care": {"label": "歩き方と配慮", "columns": ["避難時の配慮事項", "要介護度", "普段いる部屋", "寝室の場所", "ひとりになる時間帯"]},
        "evacuation": {"label": "避難先と段取り", "columns": ["避難場所", "自宅の災害リスク", "避難方法"]},
        "helper": {"label": "手伝う人", "columns": ["避難支援者1氏名", "避難支援者1続柄", "避難支援者1電話", "避難支援者2氏名", "避難支援者2続柄", "避難支援者2電話"]},
    },
    "yardsticks": [
        {"id": "slope", "label": "坂・階段・狭い道", "look": "手段（車いす・車・送迎）と家のまわりの道が合っているか", "opener": "家の前の階段は、どうやって降りますか？"}
    ],
}

script = [
    "家の裏の部屋で寝ている。裏は崖で、大雨のときが心配。ほかの災害は心配していないとのこと",
    "公民館。前にも行ったことがある",
    "長い距離は車いす",
    "一人では降りられない。誰かに手を引いてもらえば、杖で一段ずつ。車いすは階段の下に置いておく。準備に15分、公民館まで30分くらい",
    "火・木は一日中家にいる。月水金の昼はデイのまま",
    "隣の親子とあいさつをする。平日の昼は二人とも仕事で村の外。夜と休日は家にいる。避難のことはまだ何も頼んでいない",
    "家の固定電話だけ。携帯は持っていない",
    "血圧の薬と補聴器の電池を、玄関の袋にまとめておくことにした。本人が持って出る。ほかに配慮することはない",
]

for name, data in (("keahakka.mapping.json", mapping), ("hakka-village.config.json", config), ("okano.script.json", script)):
    (SAMPLES / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
