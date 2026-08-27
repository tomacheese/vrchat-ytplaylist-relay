# CLAUDE.md

## 目的
Claude Code の作業方針とプロジェクト固有ルールを示す。

## 判断記録のルール
1. 判断内容の要約を記載する
2. 検討した代替案を列挙する
3. 採用しなかった案とその理由を明記する
4. 前提条件・仮定・不確実性を明示する
5. 他エージェントによるレビュー可否を示す

## プロジェクト概要
- 目的: YouTube Playlist を VRChat World (Udon 動画プレイヤー全般) 向けに中継 (relay) するバックエンド
- 背景: VRChat 同梱の制限付き yt-dlp が googlevideo.com 直リンクの解決に失敗し 403 になる既知の問題への対策
- 主な機能:
  - yt-dlp による YouTube Playlist の取得と `manifest.json` の公開
  - Media Endpoint (`GET /:playlistId/:position.mp4`) — `redirect` (YouTube へ 302) / `proxy` (yt-dlp + ffmpeg でダウンロード・キャッシュして直接配信) の 2 方式
  - Position Pool によるスロット↔動画ID の安定対応 (Playlist 更新でも VRCUrl を焼き込み直さずに済む)

## 重要ルール
- 会話言語: 日本語
- コメント言語: 日本語
- エラーメッセージ言語: 英語
- PR / コミットメッセージ: Conventional Commits (日本語 description)
- 日本語と英数字の間には半角スペースを挿入する。

## 環境のルール
- ブランチ命名: Conventional Branch (feat, fix)
- GitHub リポジトリ調査方法: 必要に応じてテンポラリディレクトリに clone して検索する
- Renovate PR: 追加コミットや更新を行わない

## コード改修時のルール
- エラーメッセージの絵文字統一: 既存のメッセージに絵文字がある場合は、内容に即した絵文字を先頭に付与する。
- TypeScript: `skipLibCheck` の使用を禁止する。
- docstring: 関数やインターフェースには JSDoc 等を日本語で記載する。

## 開発コマンド
```bash
# インストール
pnpm install

# 開発 (tsx watch によるホットリロード)
pnpm dev

# 実行 (ビルド後に node で起動)
pnpm build && pnpm start

# Lint / 型チェック
pnpm lint

# 自動修正
pnpm fix

# テスト (yt-dlp 実行なしの軽量テスト)
pnpm test

# テスト (実 yt-dlp / ffmpeg / ネットワークを使う統合テストを含む)
pnpm test:integration

# Playlist の手動リフレッシュ (CLI)
pnpm refresh
```

## アーキテクチャと主要ファイル
- `src/index.ts`: エントリーポイント (HTTP サーバー起動)
- `src/cli.ts`: `pnpm refresh` などの CLI エントリーポイント
- `src/app.ts`: Express App 組み立て (Router の登録順を管理)
- `src/config.ts`: 環境変数 / `config/playlists.json` からの設定読み込み
- `src/ytdlp.ts`: yt-dlp 実行 (Playlist 取得 / 動画ダウンロード)
- `src/manifest-store.ts`: Position Pool (スロット↔動画ID) の構築・永続化
- `src/media-cache.ts`: `proxy` モードのダウンロード・キャッシュ・LRU Eviction・Prefetch
- `src/refresh.ts`: Playlist の定期リフレッシュとメモリキャッシュ
- `src/routes/`: `health` / `admin` / `manifest` / `media` / `root` の各 Router
- `Assets/Tomachi/YamaPlayerRemotePlaylist` (別リポジトリ): この Backend を消費する VRChat World 側実装

## 実装パターン
- 推奨: 設定は `AppConfig` を介して受け渡し、環境変数への直接アクセスは `config.ts` に閉じる。
- 非推奨: Router 実装への Playlist 定義のハードコード (`config/playlists.json` を経由すること)。

## テスト
- テストランナー: Vitest。`test/**/*.test.ts` を対象とする。
- 実 yt-dlp / ffmpeg / ネットワークに依存するテストは `RUN_INTEGRATION=1` (`pnpm test:integration`) のときのみ実行する (`test.skipIf` で分岐)。CI では `pnpm test` のみ実行する。

## ドキュメント更新ルール
- 配信方式 (`MEDIA_DELIVERY_MODE`) や設定項目を変更した場合: `README.md` と `.env.example` を更新する。

## 作業チェックリスト

### 新規改修時
1. プロジェクトを理解する
2. 作業ブランチが適切であることを確認する
3. 最新のリモートブランチに基づいた新規ブランチであることを確認する
4. 不要ブランチが削除済みであることを確認する
5. pnpm で依存関係をインストールする

### コミット・プッシュ前
1. Conventional Commits に従っていることを確認する
2. センシティブな情報が含まれていないことを確認する
3. Lint / Format エラーがないことを確認する
4. 動作確認を行う

### PR 作成前
1. PR 作成の依頼があることを確認する
2. センシティブな情報が含まれていないことを確認する
3. コンフリクトの恐れがないことを確認する

### PR 作成後
1. コンフリクトがないことを確認する
2. PR 本文が最新状態のみを網羅していることを確認する
3. `gh pr checks` で CI を確認する
4. Copilot レビューに対応する

## セキュリティ / 禁止事項
- `ADMIN_TOKEN` などの認証情報を Git にコミットしない。
- ログに機密情報 (認証情報・設定値) を出力しない。
- 設定値は環境変数または設定ファイル経由で受け取り、ソースにハードコードしない。

## リポジトリ固有
- `proxy` モードは YouTube 動画データを Backend にダウンロード・再配信するため、利用規約上のリスクを運用者が許容していることが前提。
- `config/playlists.json` に対象の YouTube Playlist を列挙する。
- `data/` はアプリケーション実行時データ (Position Pool 状態・Media キャッシュ) の永続化先で、Git 管理対象外。
