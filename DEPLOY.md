# Vercel へのデプロイ手順

このアプリは Vercel にデプロイすると、にじさんじ配信追加・勢いランキング追加を含む
**全機能が公開サイトで動作**します（`/api/*.py` がサーバーレス関数として動くため）。

## 構成
```
index.html                  … フロントエンド（静的配信）
api/nijisanji-streams.py     … /api/nijisanji-streams
api/ikioi-streams.py         … /api/ikioi-streams?keyword=X
vercel.json                  … 関数設定
server.py                    … ローカル開発用（Vercel では未使用・.vercelignore 済み）
```
Python は標準ライブラリのみ使用のため `requirements.txt` は不要です。

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
- 同時視聴者数を使う場合は、⚙ から YouTube Data API キーを入力
  （キーには Vercel の公開ドメインを **HTTP リファラー制限**に追加すること）

## ローカル開発
従来どおり `python server.py` → http://localhost:8080 でも全機能が動きます。
