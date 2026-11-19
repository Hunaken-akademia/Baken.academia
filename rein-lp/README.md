# REIN 公式ページ（宣伝用LP）

WAKE の公式ページ（newhunaken456 の `lp/`、wakekyotei.com）と同じ形で作った、REIN の宣伝用の静的ページです。
アプリ本体（`rein-web/`）とは別の1枚のページです（ビルド不要、JavaScriptなし）。

## 中身
- `index.html` … ページ本体（CSSも中に入っています）。ヒーローと「人気とのズレ」の図は、実画面をもとにHTMLで描いた表示例です
- `tokushoho.html` / `terms.html` / `privacy.html` … 特定商取引法に基づく表記・利用規約・プライバシーポリシー（`legal.css` で共通の見た目）
- `images/og.png` … SNSで共有したときの画像（1200×630）
- `vercel.json` … この宣伝ページ用の設定。`/free` は無料版、`/login` は会員ログイン、`/join` は料金欄へ転送します

## 公開のしかた（Vercel）
新しいVercelプロジェクトを作り、Root Directory を `rein-lp` にします。
Framework は「Other」、Build Command は空のままで公開できます。

ドメインは仮で `https://rein-lp.vercel.app/` と書いています。独自ドメインやプロジェクト名が決まったら、
`index.html`・各規約ページの canonical / og:url / og:image / JSON-LD と `sitemap.xml`・`robots.txt` の URL を置き換えてください。

## リンク先
- 無料版：`https://rein-web.vercel.app/free`（ログイン不要。毎日 中央1場・地方1場、重賞のない場）
- 会員ログイン：`https://rein-web.vercel.app/login`
- BOOKERS 加入ページ：地方 800円 `9aee480f-…`／中央 800円 `4d1af8db-…`／オール 1,000円 `c9b4b8a8-…`

## 公開前に確認すること
- 無料版の範囲（印・着順適性・馬の比較・展開・結果まで無料、参考買い目・辞典・オッズの動き一覧などは有料）が実装と合っているか（重賞は会員版のみ）
- 参考買い目の券種数（現在は7券種：単勝・複勝・枠連・馬連・ワイド・馬単・3連複）
- 検証値の数字は載せていません。載せるときは reports/ の結果と、期間・母数・「将来を約束しない」旨を必ず添える
