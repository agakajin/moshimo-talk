# hinan-hanashi

- 返答とコメントは日本語
- 実在の個人情報・鍵・トークンをコミットしない。デモは架空データだけ
- 氏名・住所・電話番号・生年月日を Claude API に送らない
- 医療の判断をする機能を作らない。AI が高齢者や手伝う人に直接連絡する機能も作らない
- テストは `npm test`。本物の Claude は呼ばない。`scripts/try-claude.mjs --go` は有料なので、実行前に確認する
- Claude への指示は `src/server/prompts.js`、答えの検査は `src/server/claude.js`。送る中身や出力を変えたら privacy-reviewer に見てもらう
