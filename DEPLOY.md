# Vercel へのデプロイ手順

このアプリは Vercel にデプロイすると、にじさんじ配信追加・勢いランキング追加を含む
**全機能が公開サイトで動作**します（`/api/*.py` がサーバーレス関数として動くため）。

## 構成
```
index.html                  … フロントエンド（静的配信）
assets/app.js               … フロントエンド本体
assets/parse.js             … URL / ID の解析（Node のテストからも読み込む）
assets/styles.css           … スタイル
api/nijisanji-streams.py     … /api/nijisanji-streams
api/ikioi-streams.py         … /api/ikioi-streams?keyword=X
api/vmiru-streams.py         … /api/vmiru-streams
api/youtube-live.py          … /api/youtube-live?channel=@handle（配信中の動画 ID を返す）
stream_sources/              … ローカル・Vercel共通の取得/正規化/キャッシュ処理
stream_sources/api.py        … API のルーティングと JSON レスポンス（ローカル・Vercel 共通）
vercel.json                  … 関数設定
server.py                    … ローカル開発用（Vercel では未使用・.vercelignore 済み）
```
Python は標準ライブラリのみ使用のため `requirements.txt` は不要です。

API を追加するときは `stream_sources/api.py` の `ROUTES` に登録し、
`api/<名前>.py` に `class handler(ApiHandler): route = "/api/<名前>"` を置きます。

## デプロイ方法（どちらか）

### A) GitHub 連携（推奨・自動デプロイ）
1. このフォルダを GitHub リポジトリに push
2. https://vercel.com にログイン → **Add New → Project**
3. リポジトリを import
4. Framework Preset は **Other**（ビルドコマンドなし）のまま **Deploy**
5. 以降は git push するたびに自動で再デプロイ

### B) Vercel CLI
```bash
npm i -g vercel
cd このフォルダ
vercel            # 初回はプロジェクト設定の質問に答える
vercel --prod     # 本番デプロイ
```

## デプロイ後
- 公開 URL（例: `https://xxx.vercel.app`）にアクセス
- 同時視聴者数は、ぶいみる掲載の配信ならキーなしで表示されます。
  すべての YouTube ライブで表示したい場合は、⚙ から YouTube Data API キーを入力
  （キーには Vercel の公開ドメインを **HTTP リファラー制限**に追加すること）

## ローカル開発
`python server.py` → http://localhost:8080 で全機能が動きます。
- ポートは環境変数 `PORT`、待ち受けアドレスは `HOST`（既定 `127.0.0.1`）で変更できます。
- 配信されるのは `index.html` と `assets/` だけです（ソースコードや `.git` は公開されません）。
- テスト: `python -m unittest discover -s tests` / `node --test tests/*.test.js`
