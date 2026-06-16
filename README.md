# 共有「後で」リスト（Slack + SQLite）

Slackの「後で」(Save it for Later) には公開APIがないため、共有タスクリストを自作したもの。

- **登録**: グローバルショートカット「後でに追加」/ メッセージショートカット「共有リストに保存」/ `/later`
- **全員に見える**: App Home タブ（誰が開いても同じ共有リスト）。任意で `LIST_CHANNEL` にミラー表示
- **完了・アーカイブで消える**: 各タスクのボタン → SQLite の status 更新 → 一覧から除外

## できること / 制約

- Home は開いた瞬間に再描画。他人が更新 → 自分は次に開いた時に反映（リアルタイム同期はしない）
- リアルタイムで皆に見せたい → `LIST_CHANNEL` を設定。変更のたびに1メッセージを更新（閲覧専用、操作は Home で）

## セットアップ

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → `manifest.yaml` を貼る
2. **Basic Information → App-Level Tokens** で scope `connections:write` のトークン発行（`xapp-…`）
3. ワークスペースに **Install**。**OAuth & Permissions** の Bot Token（`xoxb-…`）を取得
4. `.env.example` を `.env` にコピーし、トークンを記入（チャンネルミラー使うなら `LIST_CHANNEL` も）
   - チャンネルミラー時は対象チャンネルに bot を招待: `/invite @共有「後で」`
5. 依存インストール & 起動:

```bash
npm install
npm start
```

Socket Mode のため公開URL不要。`⚡️ 共有「後で」app 起動` が出れば稼働中。

## 使い方

- アプリの **ホーム**タブ → 共有リスト表示 + 「＋ タスク追加」
- 任意メッセージの **…** → 「共有リストに保存」（permalink付きで保存）
- どこでも `/later 牛乳を買う` で即追加、`/later` だけで入力モーダル
- 各タスクの **✅完了 / 🗄アーカイブ** で一覧から消える（DBには履歴として残る）

## 必要環境

- Node.js 18+（`better-sqlite3` のネイティブビルドに build-essential / Xcode CLT が必要な場合あり）

## 拡張案

- リアクション ✅ で完了 → `reaction_added` イベント購読（scope `reactions:read`）
- 担当者・期限カラム追加、`status` で絞り込みビュー
- 完了/アーカイブ済みの閲覧タブ
