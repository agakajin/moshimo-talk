// 声メモや文の列を Claude に渡す前に、手元の名前・住所・電話番号と、それらしい形を置き換える
// 画面からの送信は止めず、ここで置き換える。ふつうの話で訪問を止めないため
// 手元に無い人の名前は完全には見分けられない。続き柄で話す運用とあわせて使う
import { normalizeText, toHalfWidth, kataToHira, halfKanaToFull } from "./normalize.js";

const DIGIT = "0-9〇零一二三四五六七八九";
const SEP = "[\\-‐‑–—―−ーｰ.．。の・,，、/／_()（）:：~〜\\s]";
const PHONE = new RegExp(`(?<![${DIGIT}])[${DIGIT}](?:${SEP}{0,3}[${DIGIT}]){8,10}(?![${DIGIT}])`, "g");
const COUNTRY_CODE = /\+\s*81[\s\-‐ー−()（）]*0?/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const NOT_DIGIT = new RegExp(`[^${DIGIT}]`, "g");
const SEP_RUN = new RegExp(`${SEP}+`);

const N = "[0-9一二三四五六七八九十〇元]{1,4}";
const GAP = "[の、\\s]*";
const YEAR = `(?:(?:明治|大正|昭和|平成|令和|昭|平|令)\\s*${N}|(?<![A-Za-z])[TSHRtshr]\\.?\\s*\\d{1,2}|(?:19|20)\\d{2})`;
// 年月だけの「平成30年7月の大雨」は災害の話なので残す。生まれた年や、生年月日と言った日付は置き換える
const DATE = new RegExp(
  `${YEAR}\\s*年${GAP}${N}\\s*月${GAP}${N}\\s*(?:日|(?![0-9一二三四五六七八九十回人本枚度時分階歳件台つ個号軒]))|${YEAR}\\s*[.\\/\\-・]\\s*\\d{1,2}\\s*[.\\/\\-・]\\s*\\d{1,2}(?!\\d)|${YEAR}\\s*年(?:${GAP}${N}\\s*月)?(?=の?に?生|の?うまれ)|(?<=(?:生年月日|誕生日)[はがの:：\\s]{0,3})${N}\\s*年${GAP}${N}\\s*月${GAP}${N}\\s*日?|(?<!\\d)(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])(?!\\d)|${N}\\s*月${GAP}${N}\\s*日(?=の?に?生|の?うまれ|が誕生日)|(?<=誕生日[はがの:：\\s]{0,3})${N}\\s*月${GAP}${N}\\s*日?|${N}\\s*年${GAP}${N}\\s*月${GAP}${N}\\s*日(?=の?に?生|の?うまれ|が誕生日)|(?<=(?:生まれ|うまれ)[はがの:：\\s]{0,3})${YEAR}\\s*年(?:${GAP}${N}\\s*月)?`,
  "g",
);
const POSTAL = /〒\s*\d{3}[-‐ー−]?\d{0,4}/g;
// 「三丁目の公民館」「三丁目2軒目」は場所の話なので、丁目だけでは置き換えない。「点字ブロック3枚」「T字杖」「十字路」の字も住所ではない
const ADDRESS = /(?<![点文数漢赤名A-Za-z十丁習活])大?字[\p{Script=Han}ァ-ヶ]{1,10}\s*\d+(?:\s*[-‐ー−番の]\s*\d+)*(?:番地|号)?|[0-9一二三四五六七八九十百]{1,8}\s*番地(?:\s*[0-9一二三四五六七八九十]+)?(?:\s*号)?|[0-9一二三四五六七八九十百]{1,8}\s*丁目\s*[0-9一二三四五六七八九十]+(?![0-9一二三四五六七八九十軒人本枚回階分時度つ])(?:\s*[-‐ー−番の]\s*\d+)*(?:\s*号)?|[\p{Script=Han}ァ-ヶ]{1,8}[町村台丘]の?\s*\d+(?:\s*[-‐ー−の番]\s*\d+)+(?:\s*号)?|[0-9一二三四五六七八九十百]{1,8}\s*丁目の\s*\d+(?:\s*[-‐ー−の番]\s*\d+)+(?:\s*号)?|\d+\s*番\s*\d+\s*号|(?:荘|ハイツ|マンション|アパート|コーポ|レジデンス)の?\s*\d+(?![\d階棟部屋])(?:号室?)?|\d+号室/gu;

// 「さん」が付いても名前ではない言葉
const NOT_A_NAME = new Set([
  "本人", "緊急連絡先", "人", "方", "子", "皆", "赤", "猫", "犬", "ワン", "同", "模", "雨模", "多", "各", "王", "神", "仏",
  "娘", "息子", "奥", "嫁", "婿", "孫", "母", "父", "祖母", "祖父", "兄", "姉", "弟", "妹", "夫", "妻", "旦那", "親", "親戚", "甥", "姪", "叔母", "伯母", "叔父", "伯父",
  "長男", "次男", "三男", "長女", "次女", "三女", "義母", "義父", "家族", "兄弟", "姉妹", "親子",
  "利用者", "支援者", "対象者", "申請者", "入居者", "保護者", "担当者", "契約者",
  "自分", "親類", "いとこ", "豆腐屋", "灯油屋", "クリーニング屋", "知り合い", "合い", "集落", "地区", "班", "組", "町内", "訪問", "主治医", "宮", "八幡", "稲荷", "天神", "氏神", "弁天", "不動", "金比羅", "大師", "拝殿", "本殿", "先祖", "陰", "互い", "有", "模", "空模", "月", "日", "馳走", "毒", "姑", "舅", "和尚", "神主", "村長", "町長", "市長", "館長", "組合長", "手伝い", "付き添い", "添い", "隣組", "当番", "見守り隊", "見守り", "隊", "薬局", "福祉用具", "訪問入浴", "特養", "事業所", "訪問介護", "生協", "農協", "郵便局員", "郵便局", "消防", "警察", "救急隊員", "救急隊", "病院", "通所", "老健", "ガス屋", "水道屋", "弁当屋", "寺", "巡り", "地蔵", "世話", "観音", "公民館", "校長", "園長", "教頭", "院長", "担任", "主治", "女性", "男性", "内科", "外科", "歯科", "眼科", "耳鼻科", "皮膚科", "整形外科", "精神科", "産婦人科", "学校", "保育園", "幼稚園",
  "隣", "近所", "大家", "民生", "民生委員", "委員", "担当", "職員", "運転手", "先生", "医者", "駐在", "社協", "施設", "郵便屋", "同様", "模様", "逆", "坊", "隣おじ", "隣おば", "近所おじ", "近所おば",
]);
const NOT_A_NAME_END = [
  "役員", "防災士", "世話人", "理事", "代表", "社長", "業者", "看護師", "看護婦", "保健婦", "社会福祉士", "配達", "店長", "議員", "サポーター", "配食", "送迎", "会", "ケアマネジャー", "ケアマネージャー", "ケアマネ", "ヘルパー", "会長", "区長", "班長", "組長", "館長", "団長", "役所", "デイサービス", "夫婦", "モ様",
  "娘", "息子", "奥", "嫁", "婿", "孫", "母", "父", "兄", "姉", "弟", "妹", "婆", "爺", "隣", "っ",
  "医者", "医師", "薬剤師", "美容師", "理容師", "管理人", "主人", "友人", "知人", "老人", "隣人", "住人", "ボランティア", "客", "看護", "デイ",
  "八百屋", "魚屋", "米屋", "酒屋", "床屋", "薬屋", "電気屋", "大工", "職員", "店員", "委員", "団員", "同じ", "たく", "疲れ", "苦労", "摂",
  // 土屋さんや雄士さんを残さないよう、「屋」「士」だけでは名前から外さない
  "訪看", "包括", "保健師", "相談員", "支援員", "療法士", "介護士", "介護福祉士", "消防士", "消防団", "ショートステイ", "役場", "住職", "パン屋", "新聞屋", "タクシー", "向かい",
];
// 「山田ちゃんと一緒に」は名前。「薬ちゃんと飲む」「手すりちゃんと掴んで」は、ふつうの言葉
// 「行くんですね」は復唱でよく出る。1字の動詞のあとの「くんで」「くんだ」は名前と見ない
const WATER = new Set(["水", "お水", "井戸水", "飲み水", "雨水"]);
const VERB_BEFORE_KUN = new Set([..."行歩動聞書置着届開続働泣引抜付焼効吹敷突解磨招向空履乾叩抱巻"]);
// 様式の見出しでよく見る「カナ氏名」など。「佐藤氏名古屋へ」は名前のまま
const BEFORE_SHIMEI = new Set(["緊急", "カナ", "フリガナ", "被保険者", "同行者", "代表者", "避難者", "世帯主", "申込者", "入所者", "患者", "主治医", "医師", "連絡先"]);
const ROLE_AFTER = /^(?:ケアマネ|ヘルパー|看護師|保健師|会長|区長|班長|組長|民生委員|先輩)/;
const isOrdinary = (word, after) => (after.startsWith("氏名") && [word, word.replace(/様$/, "")].some((w) => BEFORE_SHIMEI.has(w) || NOT_A_NAME.has(w) || /(?:[者人主医族柄先長員師]|カナ|ソン)$/.test(w)))
  // 「歩ける様に」は、名前の「山田様に」と違う
  || (after.startsWith("様に") && /[ぁ-ゖ]$/.test(word))
  || (after.startsWith("ちゃんと") && !/^ちゃんと(?:一緒|二人|ふたり|話|来|行|会|住|暮|避難|逃げ|は|が)/.test(after))
  // 敬称のない「田中ケアマネ」は名前。「自治会長」「来たヘルパー」は違う
  || (ROLE_AFTER.test(after) && (word.length < 2 || /[ぁ-ゖ]/.test(word) || NOT_A_NAME.has(word) || ROLE_PREFIX.test(word))) || (/^くん(?:で|だ|じゃ|なら)/.test(after) && (WATER.has(word) || VERB_BEFORE_KUN.has(word) || /[ぁ-ゖ]$/.test(word)));
const NAME = /(?:(?<![ぁ-ゖ])[ぁ-ゖ]{2,3}(?<![のっ])[子江男代美恵枝郎]|(?:(?<![ぁ-ゖ])|(?<=さん|ちゃん))[ぁ-ゖ]{2,5}(?=\s?(?:さん|さま|ちゃん(?!と)))|[A-Z]?[a-z]{3,}|[\p{Script=Han}々ァ-ヶー]{1,20}(?:(?![のにはをがとへもで])[ぁ-ゖ]){0,3})(?=\s?(?:さん(?!ざん)|様(?!子|便|がな|式|々)|さま|氏|ちゃん|くん|君(?![がのた])|先生|医師|殿(?!様)|ケアマネ|ヘルパー|看護師|保健師|会長|区長|班長|組長|民生委員|先輩))/gu;
// 職業の語は、前に名字が付くことがある（山田会長、佐藤看護師）。短い前置きと、決まった前置きだけを職業として残す
const ROLE_END = new Set(["役員", "防災士", "世話人", "理事", "代表", "社長", "業者", "看護師", "看護婦", "ケアマネジャー", "ケアマネージャー", "ケアマネ", "ヘルパー", "会長", "区長", "班長", "組長", "医者", "医師", "薬剤師", "美容師", "理容師", "管理人", "保健師", "相談員", "支援員", "療法士", "介護士", "介護福祉士", "消防士", "大工", "職員", "店員", "委員", "団員", "住職"]);
const ROLE_PREFIX = /(?:自治|町内|地区|集落|老人|介護|訪問|担当|主任|民生|児童|社協|役場|包括|福祉|在宅|居宅|消防|婦人|地域|支援|生活|相談|病院|施設|看護|理学|作業|言語|歯科|精神|保健|新人|女性|男性|平日|毎朝|毎週|毎日|今日|昨日|明日|今週|来週|先週|午前|午後|曜|ホーム|ガイド|夜間|巡回|校区|クラブ|役所|学校|保育|デイ|ケア|隣|近所)$/;
// 平仮名だけの語で、名前ではないもの
// 2字の語は完全に一致するときだけ外す（「さとう」「かとう」を「とう」で外さない）
const HIRAGANA_SHORT = new Set(["のおっ", "のばっ", "のじっ", "おっ", "ばっ", "じっ", "いとこ", "たく", "みな", "おじ", "おば", "おこ", "おく", "かあ", "とう", "ねえ", "にい", "あか", "よめ", "まご", "むこ", "ねこ", "いぬ", "わん", "ばあ", "じい"]);
const HIRAGANA_WORD = ["ばあ", "じい", "よめ", "まご", "ほとけ", "おはよう", "どなた", "だれか", "なんとか", "にゃん", "おじい", "おばあ", "おかあ", "おとう", "おねえ", "おにい", "おじ", "おば", "おこ", "おく", "むすめ", "むすこ", "おとなり", "となり", "ごしゅじん", "おきゃく", "おいしゃ", "いしゃ", "みんな", "あなた", "こども", "ごくろう", "おつかれ", "ごちそう", "おかげ", "おたがい", "おだいじに", "おてら", "おまわり", "ようちえん", "おじぞう", "おつき"];
function isHiraganaName(word) {
  const rest = word.replace(/^(?:うちの|あの|その|この|わたしの)/, "");
  return !HIRAGANA_SHORT.has(rest) && !HIRAGANA_WORD.some((w) => rest.endsWith(w));
}
function isName(word) {
  if (/^[ぁ-ゖ]+$/.test(word)) return isHiraganaName(word);
  if (NOT_A_NAME.has(word)) return false;
  const end = NOT_A_NAME_END.filter((e) => word.endsWith(e)).sort((a, b) => b.length - a.length)[0];
  if (!end) return true;
  if (!ROLE_END.has(end)) return false;
  const before = word.slice(0, -end.length);
  return before.length >= 2 && !ROLE_PREFIX.test(before);
}

// 音声認識は普通の字を出しやすいので、字体をそろえて探す
const FOLD = { "髙": "高", "﨑": "崎", "𠮷": "吉", "齋": "斎", "齊": "斎", "斉": "斎", "濵": "浜", "濱": "浜", "邊": "辺", "邉": "辺", "德": "徳", "惠": "恵", "櫻": "桜", "廣": "広", "澤": "沢", "嶋": "島", "眞": "真", "壽": "寿", "國": "国", "榮": "栄", "瀧": "滝", "冨": "富", "塚": "塚" };
const fold = (s) => [...s.normalize("NFKC")].map((c) => FOLD[c] ?? c).join("");

const hiraToKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const onlyKana = (s) => /^[ぁ-ゖァ-ヶー]+$/.test(s);
// 読みの短い部分（はじめ、なかの）は普通の言葉と重なるので、単独では置き換えない
const longEnough = (part) => part.length >= (onlyKana(part) ? 4 : 2);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 「平和台公民館」「川上橋」は、名前と同じ字で始まる地名として残す
const NOT_PLACE = "(?![台橋川山駅町村園]|の?(?:公民館|集会所|保育園|幼稚園|体育館|公園|郵便局|バス停|交差点|小学校|中学校|高校|神社|団地|病院|地区|集落|避難所|高台|寺|広場|センター|会館)|を渡|があふれ|が溢れ|沿い|[にへ]逃げ)";
// 「準備に10-15分」は番地ではない
const NOT_AMOUNT = "(?![0-9分人時歳回度階枚])";
// 「1番2番の順に回る」は番地ではない。地名が付いた形は「番」が続いても置き換える
const formPattern = (form, kind) => new RegExp(`${escapeRegExp(form)}${kind === "address" ? `${NOT_AMOUNT}${/^\d+番\d+$/.test(form) ? "(?!番)" : ""}` : NOT_PLACE}`, "g");

function variants(value) {
  const text = fold(normalizeText(value));
  const out = new Set();
  const add = (part) => { if (longEnough(part)) out.add(part); };
  // 空白のない氏名は、名字だけ、名前だけでも探す
  for (const part of text.split(" ")) if (text.includes(" ") && /^[ァ-ヶー]{2,}$/.test(part)) out.add(part);
  const kanaGiven = /^([\p{Script=Han}々]+)([ぁ-ゖァ-ヶー]+[\p{Script=Han}々]?)$/u.exec(text);
  if (kanaGiven) {
    add(kanaGiven[1]);
    add(kanaGiven[2]);
    // 片仮名の名前（トメ）は短くても言葉と重なりにくい
    if (/^[ァ-ヶー]{2,}$/.test(kanaGiven[2])) out.add(kanaGiven[2]);
  }
  if (/^[\p{Script=Han}々]{3,5}$/u.test(text)) {
    add(text.slice(0, 2));
    add(text.slice(2));
    if (text.length !== 4) { add(text.slice(0, 3)); add(text.slice(-2)); }
  }
  [text, text.replace(/\s/g, ""), ...text.split(" ")].forEach(add);
  const hira = kataToHira(halfKanaToFull(text));
  for (const form of [hira, hiraToKata(hira)]) [form, form.replace(/\s/g, ""), ...form.split(" ")].forEach(add);
  return [...out];
}

// 短い読みは「さん」が付いたときだけ。一部分を置き換えて文を壊さない
function honorific(value) {
  const text = fold(normalizeText(value));
  const hira = kataToHira(halfKanaToFull(text));
  const parts = [text.replace(/\s/g, ""), hira.replace(/\s/g, ""), hiraToKata(hira).replace(/\s/g, ""), ...text.split(" "), ...hira.split(" "), ...hiraToKata(hira).split(" ")].filter((p) => p.length >= 2);
  return parts.flatMap((p) => [`${p}さん`, `${p}様`, `${p}さま`]);
}

const LOT_OR_BUILDING = /\d|字|[一二三四五六七八九十百]+\s*(?:番|丁目)|号室|棟|荘|ハイツ|マンション|アパート|コーポ|レジデンス/;
// 住所は全部を言わないことが多いので、字名と番地でも探す。「ハッカ村」のように広い言葉は置き換えない
function addressVariants(value) {
  const text = toHalfWidth(fold(normalizeText(value)));
  const out = new Set([text, text.replace(/\s/g, "")]);
  const tail = /字.*$/.exec(text)?.[0] ?? text.replace(/^.*[都道府県市区村郡]/, "").trim();
  // 番地だけの短い形は、時間や人数と重なるので単独では置き換えない
  // 番地のない地名だけ（「川上の公民館」）も場所の話なので残す
  if (tail && LOT_OR_BUILDING.test(tail) && !/^[\d\s\-‐ー−]{1,4}$/.test(tail)) {
    out.add(tail);
    out.add(tail.replace(/\s/g, ""));
  }
  const area = /^大?字?([^\d\s]+)/.exec(tail)?.[1];
  const lot = /(\d+)\s*[-‐ー−]\s*(\d+)(?:\s*[-‐ー−]\s*\d+)?/.exec(tail);
  if (lot) {
    const [, a, b] = lot;
    if (lot[0].length >= 5) out.add(lot[0]);
    const forms = [`${a}番地${b}`, `${a}番${b}号`, `${a}番${b}`, `${a}の${b}`];
    for (const form of forms) if (!form.endsWith(`の${b}`) || area) out.add(area ? `${area}${form}` : form);
    if (area) {
      out.add(`字${area}${lot[0]}`);
      out.add(`${area}${lot[0]}`);
      out.add(`大字${area}${lot[0]}`);
      forms.forEach((form) => out.add(`字${area}${form}`));
      forms.slice(0, 3).forEach((form) => out.add(form));
    }
  }
  // 字名だけ（「川上の公民館」）は場所の話なので残し、「字川上」と言ったときだけ置き換える
  if (area && lot) {
    out.add(`${area}の${lot[1]}の${lot[2]}`);
    out.add(`${area}の${lot[0]}`);
    out.add(`${area}${lot[1]}`);
  }
  const building = /[\p{Script=Han}ァ-ヶーぁ-ゖ]{2,}(?:荘|ハイツ|マンション|アパート|コーポ|レジデンス|住宅|団地|棟|寮)/u.exec(text)?.[0];
  if (building) {
    out.add(building);
    const room = new RegExp(`${escapeRegExp(building)}\\s*(\\d+)`).exec(text)?.[1];
    const short = building.replace(/^[市県村町都府道]営/, "");
    out.add(short);
    if (room) for (const name of [building, short]) {
      out.add(`${name}${room}`);
      out.add(`${name}の${room}`);
    }
  }
  const three = /(\d+)\s*[-‐ー−]\s*(\d+)\s*[-‐ー−]\s*(\d+)/.exec(text);
  if (three) out.add(`${three[1]}の${three[2]}の${three[3]}`);
  if (lot && lot[1].length >= 3) out.add(`${lot[1]}の${lot[2]}`);
  const banchi = /(\d+)番(\d+)/.exec(text);
  if (banchi) {
    out.add(`${banchi[1]}-${banchi[2]}`);
    out.add(`${banchi[1]}の${banchi[2]}`);
  }
  if (area && lot) {
    const hira = kataToHira(area);
    for (const name of [hira, hiraToKata(hira)]) {
      out.add(`${name}${lot[0]}`);
      out.add(`${name}${lot[1]}の${lot[2]}`);
      if (three) out.add(`${name}${three[1]}の${three[2]}の${three[3]}`);
    }
  }
  if (area && area.length >= 2) {
    out.add(`字${area}`);
    out.add(`大字${area}`);
  }
  return [...out];
}

// 生年月日は「4月12日生まれ」「昭和14年」のように言い方が多い
const ERA_BASE = [["平成", 1988, 1989], ["昭和", 1925, 1926], ["大正", 1911, 1912], ["明治", 1867, 1868]];
function birthForms(value) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!hit) return [];
  const [y, m, d] = [+hit[1], +hit[2], +hit[3]];
  const kanji = (n) => (n < 10 ? "〇一二三四五六七八九"[n] : `${n >= 20 ? "〇一二三四五六七八九"[Math.floor(n / 10)] : ""}十${n % 10 ? "〇一二三四五六七八九"[n % 10] : ""}`);
  const forms = [`${y}年${m}月${d}日`, `${m}月${d}日`, `${kanji(m)}月${kanji(d)}日`];
  const era = ERA_BASE.find(([, , from]) => y >= from);
  if (era) {
    const wy = y - era[1];
    forms.push(`${era[0]}${wy}年${m}月${d}日`, `${wy}年${m}月${d}日`, `${era[0]}${kanji(wy)}年${kanji(m)}月${kanji(d)}日`, `${era[0]}${wy}年`, `${era[0]}${kanji(wy)}年`);
  }
  return forms;
}

// どの形の名前や住所から置き換えても壊れないよう、長いものから置き換える
function replacements(known) {
  const pairs = [];
  for (const { value, alias, kind } of known) {
    if (!value || kind === "phone") continue;
    if (kind === "birth") {
      for (const v of birthForms(value)) pairs.push([v, alias, kind]);
      continue;
    }
    if (kind === "whole") {
      pairs.push([fold(normalizeText(value)), alias, kind]);
      continue;
    }
    if (kind === "address") {
      for (const v of addressVariants(value)) pairs.push([v, alias, kind]);
      continue;
    }
    for (const v of [...variants(value), ...honorific(value)]) pairs.push([v, alias, kind]);
  }
  return pairs.sort(([a], [b]) => b.length - a.length);
}

// 頭の 0 が落ちた番号（90-1234-5678）、国番号から話した番号（8190…）、区切りのない長い番号
const LOST_ZERO = /(?<![\d-])(?:81[-\s]?\d{1,2}[-\s]?\d{4}[-\s]?\d{4}|[1-9]\d[-‐ー−\s]?\d{4}[-‐ー−\s]?\d{4}|[1-9]\d{1,3}-\d{1,4}-\d{4}|[1-9]\d{9,})(?![\d-])/g;
function maskPhones(text) {
  return text.replace(COUNTRY_CODE, "0").replace(LOST_ZERO, "[電話番号]").replace(PHONE, (m) => {
    const digits = m.replace(NOT_DIGIT, "");
    const parts = m.split(SEP_RUN);
    // 区切りが多い数字は箇条書きが多いので除く。1桁ずつ読んだ番号だけは数える
    return /^[0〇零]/.test(digits) && digits.length >= 9 && (parts.length <= 4 || parts.every((p) => p.length === 1)) ? "[電話番号]" : m;
  });
}
// 話した番号は「ええと」が挟まったり、仮名で出たり（ゼロキューゼロ）、桁が崩れたりする。文は変えず、番号の部分だけを置き換える
// 正規表現の繰り返しにすると長い文で遅くなるので、1字ずつ読む
const NUMBER_START = /(?<![0-9〇零一二三四五六七八九])(?:[0〇零]|ゼロ|ぜろ|マル|まる|レイ|れい|オー)/g;
const KATAKANA_DIGIT = "ゼロ|マル|レイ|オー|イチ|ニ|サン|シチ|シ|ヨン|ゴ|ロク|ナナ|ハチ|キュウ|キュー|ク";
const HIRAGANA_DIGIT = "ぜろ|まる|れい|いち|に|さん|しち|し|よん|ご|ろく|なな|はち|きゅう|きゅー|く";
const NUMERIC_TOKEN = new RegExp("[0-9〇零一二三四五六七八九]|" + KATAKANA_DIGIT, "y");
const ANY_TOKEN = new RegExp("[0-9〇零一二三四五六七八九]|" + KATAKANA_DIGIT + "|" + HIRAGANA_DIGIT, "y");
// 数字の間に挟まってよい字。「えー」は音声認識で「A」や「e」になることがある。時刻の「：」や範囲の「〜」は入れない
const GAP_CHAR = /[ぁ-ゖァ-ヶー\-‐‑–—―−ｰ・,，、。．_\s|｜()（）/／AaEe]/;
const PLAIN_GAP = /[の・,，、。．_\s\-‐‑–—―−ーｰ|｜()（）/／]/;
const MAX_GAP = 8;
const LABELLED_PHONE = /(?<=(?:電話(?:番号)?|番号|連絡先|携帯)[はがの:：\s]{0,2})\d(?:[\-‐ー−の\s]?\d){5,7}(?!\d)/g;
const LABELLED_POSTAL = /(?<=郵便番号[はが:：\s]{0,2})\d{3}[\-‐ー−]?\d{4}(?!\d)/g;
function maskSpoken(source) {
  const text = source.replace(LABELLED_POSTAL, "[郵便番号]").replace(LABELLED_PHONE, "[電話番号]");
  let out = "";
  let done = 0;
  for (const start of text.matchAll(NUMBER_START)) {
    if (start.index < done) continue;
    // 仮名で読み始めた番号だけ、平仮名を数字として数える。ふつうの文の「に」「し」を数えない
    const token = /^[ぁ-ゖ]/.test(start[0]) ? ANY_TOKEN : NUMERIC_TOKEN;
    let at = start.index + start[0].length;
    let end = at;
    let count = 1;
    let spoken = start[0].length > 1;
    let gap = 0;
    while (at < text.length && gap <= MAX_GAP) {
      token.lastIndex = at;
      const hit = token.exec(text);
      if (hit) {
        count += 1;
        if (!/^[0-9〇零一二三四五六七八九]$/.test(hit[0])) spoken = true;
        at += hit[0].length;
        end = at;
        gap = 0;
      } else if (GAP_CHAR.test(text[at])) {
        if (!PLAIN_GAP.test(text[at])) spoken = true;
        at += 1;
        gap += 1;
      } else break;
    }
    if (count < (spoken ? 9 : 10)) continue;
    out += text.slice(done, start.index) + "[電話番号]";
    done = end;
  }
  return out + text.slice(done);
}
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const maskForms = (text) => maskSpoken(maskPhones(text.replace(EMAIL, "[メール]").replace(DATE, "[日付]").replace(POSTAL, "[郵便番号]"))).replace(ADDRESS, "[住所]");
// 敬称がなくても、名前と分かる言い方
// 「娘宅」「市営住宅」「日中自宅」は名前ではない。2字以上の名字らしい語のときだけ
const namedHome = (w) => {
  const base = w.slice(0, -1);
  return base.length >= 2 && !/[自住帰在社別]$/.test(base) && !/[娘子嫁婿孫母父兄姉弟妹戚人]$/.test(base) && isName(base);
};
const PLACE_END = /(?:学校|公民館|高台|広場|センター|会館|[館所園院場駅寺山川橋])$/;
const NAMED = /(?<=名前は)[\p{Script=Han}々ァ-ヶー]{2,8}|[\p{Script=Han}々ァ-ヶー]{2,8}(?=と(?:いいます|言います|申します))/gu;
const NAMED_HOME = /[\p{Script=Han}々]{1,4}宅/gu;
// 「認知症の奥さん」「同居の息子」は伏せない。よくある名字のあとだけ名前と見る（珍しい名字は敬称や手元の値で探す）
const COMMON_SURNAME = new Set("佐藤 鈴木 高橋 田中 伊藤 渡辺 山本 中村 小林 加藤 吉田 山田 佐々木 山口 松本 井上 木村 斎藤 清水 山崎 池田 橋本 阿部 石川 山下 中島 石井 小川 前田 岡田 長谷川 藤田 後藤 近藤 村上 遠藤 青木 坂本 福田 太田 西村 藤井 金子 岡本 藤原 中野 三浦 原田 中川 松田 竹内 小野 田村 中山 和田 石田 森田 上田 内田 柴田 酒井 横山 高木 安藤 宮本 大野 小島 谷口 今井 工藤 高田 増田 丸山 杉山 村田 大塚 新井 小山 平野 藤本 河野 上野 野口 武田 松井 岩崎 菅原 木下 久保 佐野 野村 松尾 市川 菊地 杉本 古川 大西 島田 水野 桜井 高野 渡部 吉川 山内 西田 菊池 飯田 西川 小松 北村 安田 五十嵐 川口 平田 中田 久保田 服部 岩田 土屋 川崎 本田".split(" "));
const NAMED_FAMILY = /(?<![\p{Script=Han}々])[\p{Script=Han}々]{2,4}(?=の(?:奥さん|おばあちゃん|おばあさん|おじいちゃん|おじいさん|おばちゃん|おじちゃん|ばあちゃん|じいちゃん|ばあさん|じいさん|おばさん|おじさん|爺さん|婆さん|息子|娘|兄ちゃん|姉ちゃん|お嫁さん|嫁|婿|お孫さん|孫|旦那|ご主人|長男|次男|三男|長女|次女|三女|お母さん|お父さん|母|父|兄|姉|弟|妹|家|ところ|車))/gu;
const maskNames = (text) => text.replace(NAME, (word, at) => (isName(word) && !isOrdinary(word, text.slice(at + word.length)) ? "[お名前]" : word))
  .replace(NAMED, (w) => (isName(w) && !PLACE_END.test(w) ? "[お名前]" : w))
  .replace(NAMED_HOME, (w) => (namedHome(w) ? "[お名前]宅" : w))
  .replace(NAMED_FAMILY, (w) => (COMMON_SURNAME.has(w) ? "[お名前]" : w));

// 手元の番号は、下の桁だけを話したときも置き換える
function maskKnownPhones(text, known) {
  let out = text;
  for (const { value, kind } of known) {
    if (kind !== "phone" || !value) continue;
    const d = toHalfWidth(value).replace(/\D/g, "");
    if (d.length < 6) continue;
    // 頭の 0 を落として話したときも置き換える
    // 全部の桁を先に置き換える。下の桁から探すと、局番だけが残る
    out = out.replace(new RegExp(`(?<!\\d)${d.split("").join(`${SEP}{0,2}`)}(?!\\d)`, "g"), "[電話番号]");
    // 局番を言わない話し方（555の0142）も置き換える
    for (const n of [8, 7]) if (d.length >= n) out = out.replace(new RegExp(`(?<!\\d)${d.slice(-n, -4)}${SEP}{0,2}${d.slice(-4)}(?!\\d)`, "g"), "[電話番号]");
    out = out.replace(new RegExp(`(?<!\\d)${d.replace(/^0/, "").split("").join(`${SEP}{0,2}`)}(?!\\d)`, "g"), "[電話番号]");
    out = out.replace(new RegExp(`(?<!\\d)${d.slice(-6, -4)}${SEP}{0,2}${d.slice(-4)}(?!\\d)`, "g"), "[電話番号]");
  }
  return out;
}

export function redact(text, known = []) {
  let out = fold(halfKanaToFull(normalizeText(String(text).replace(INVISIBLE, ""))));
  for (const [from, alias, kind] of replacements(known)) out = out.replace(formPattern(from, kind), () => alias);
  return maskNames(maskForms(maskKnownPhones(toHalfWidth(out), known)));
}

// 計画の文字すべてを置き換えて送る形にする。手で直した欄もここを通る
export function redactDeep(node, known = []) {
  if (typeof node === "string") return redact(node, known);
  if (Array.isArray(node)) return node.map((v) => redactDeep(v, known));
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactDeep(v, known)]));
}

const standard = (text) => toHalfWidth(fold(halfKanaToFull(String(text).replace(INVISIBLE, ""))));

// 番号・日付・住所の形があるか。見出しの検査でも使う
export function formKind(text) {
  const half = standard(text);
  if (half.replace(EMAIL, "") !== half) return "メール";
  if (maskSpoken(maskPhones(half)) !== half) return "電話番号";
  if (half.replace(DATE, "") !== half) return "日付";
  if (half.replace(POSTAL, "") !== half) return "郵便番号";
  if (half.replace(ADDRESS, "") !== half) return "住所";
  return null;
}

// redact が置き換える形が残っていれば種類を返す。画面を通らない送信を入口で止めるために使う
export function personalKind(text) {
  const kind = formKind(text);
  if (kind) return kind;
  const half = standard(text);
  return maskNames(half) !== half ? "名前" : null;
}

// Claude に送る中身に本物の値が混ざっていないかを調べる。通しチェックで使う
// redact が残すと決めた形（地名として残す字など）では止めない
// 同じ作りで、手伝う人の名前の言い方を探す（市向けの文で使う）
export const nameParts = (value) => (value ? variants(value) : []);

export function findLeaks(payload, realValues) {
  const sent = fold(typeof payload === "string" ? payload : JSON.stringify(payload));
  const half = toHalfWidth(sent);
  const leaks = [];
  for (const item of realValues) {
    const { value, kind } = typeof item === "string" ? { value: item } : item;
    if (!value || !value.trim()) continue;
    const forms = kind === "address" ? addressVariants(value) : variants(value);
    const hitText = forms.some((v) => formPattern(v, kind).test(sent) || formPattern(toHalfWidth(v), kind).test(half));
    const plain = toHalfWidth(value).trim();
    const d = plain.replace(/\D/g, "");
    const isNumber = d.length >= 7 && /^[\d\-‐()\s]+$/.test(plain);
    const hitDigits = isNumber && new RegExp(d.split("").join("[\\s\\-‐ー−().。．の、,]{0,2}")).test(half);
    if (hitText || hitDigits) leaks.push(value);
  }
  return leaks;
}
