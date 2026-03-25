# peyaup — Discord から TVTest を操作する Bot

Discord のスラッシュコマンドで Windows 上の TVTest をリモート操作できる Bot です。
チャンネル変更・番組検索・視聴状態確認をすべて Discord から行えます。

## 主な機能

### `/tv` — TVTest チャンネル操作

TVTest の HTTP Plugin API を通じてチャンネルを遠隔操作します。

| サブコマンド | 説明 |
|---|---|
| `/tv channel name:...` | チャンネルを変更する（オートコンプリート対応） |
| `/tv list [query] [page]` | チャンネル一覧を表示する（名前・番組名・ネットワーク名で絞り込み可） |
| `/tv status` | 現在視聴中のチャンネルと番組情報を表示する |

#### オートコンプリート検索

`/tv channel` の `name` 引数はオートコンプリートに対応しています。入力テキストは以下の順で検索し、スコアの高い順に最大 25 件を返します。

1. チャンネル名（完全一致 > 前方一致 > 部分一致）
2. 現在放送中の番組名
3. ネットワーク名
4. BonDriver 名

番組名はリアルタイムで EPG から取得し、15 秒間キャッシュします。

#### BonDriver 切替

複数の BonDriver（地上波・BS・CS 等）をまたいだ選局に対応しています。
別 BonDriver のチャンネルを選択すると自動で切り替えてから選局します。

### その他の機能

- **配信停止監視**: 特定ユーザーの Go Live 停止・VC 離脱を検知して通知チャンネルへアラートを送信
- **`/spin`**: ギルド絵文字を使った 3×3 スロット

---

## セットアップ

### 1. TVTest 側の準備

TVTest HTTP Plugin をインストールし、TVTest を起動しておきます。
デフォルトポートは `40152` です。

### 2. Bot のセットアップ

```bash
cp .env.example .env
# .env を編集して値を設定
npm install
npm run build
```

### 3. ローカル実行

```bash
npm run dev
```

### 4. テスト

```bash
npm test
```

### 5. Docker Compose 実行

```bash
docker compose up -d --build
```

ログ確認:

```bash
docker compose logs -f watchdog
```

停止:

```bash
docker compose down
```

---

## 環境変数

### Discord / 監視設定（必須）

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | ✓ | Bot トークン |
| `GUILD_ID` | ✓ | 対象 Guild ID |
| `WATCH_USER_ID` | ✓ | 監視対象ユーザー ID |
| `MENTION_USER_ID` | | 通知時にメンションするユーザー ID（省略時は `WATCH_USER_ID`） |
| `INCIDENT_CHANNEL_ID` | ✓ | 通知先チャンネル ID |
| `DEBOUNCE_MS` | | 瞬断吸収時間 ms（デフォルト `15000`） |

### TVTest 連携設定

| 変数名 | 必須 | 説明 |
|---|---|---|
| `TVTEST_API_URL` | | TVTest HTTP Plugin の URL（例: `http://192.168.1.10:40152`）。省略時は TV 機能が無効になります |
| `TVTEST_BON_DRIVERS` | | チャンネルスキャン対象の BonDriver をカンマ区切りで指定（例: `BonDriver_Proxy_T.dll,BonDriver_Proxy_S.dll`）。省略時は起動時にロード中のドライバのみスキャン |
| `TVTEST_POST_DRIVER_SWITCH_DELAY_MS` | | BonDriver 切替後の待機時間 ms（デフォルト `1200`）。TS ドロップが出る場合は `1500〜3000` 程度に増やす |
| `TVTEST_POST_CHANNEL_CHANGE_DELAY_MS` | | チャンネル変更後の待機時間 ms（デフォルト `500`） |

TVTest が別 PC にある場合は `TVTEST_API_URL` に Windows 機の IP を指定してください。

---

## 必要な Bot 権限

- `Guilds`
- `GuildVoiceStates`
- 通知先チャンネルへの送信権限
- `/spin` `/tv` を使うチャンネルへの送信権限
- Bot 招待時に `applications.commands` スコープ

---

## TVTest HTTP Plugin API を使用します

本 Bot は以下のエンドポイントを使用します。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/status` | 現在のチャンネル・番組・音量情報を取得 |
| GET | `/api/channels` | チャンネル一覧を取得 |
| GET | `/api/driver` | BonDriver 情報を取得 |
| POST | `/api/channel` | チャンネルを変更 |
| POST | `/api/driver` | BonDriver を切り替えてチャンネルを変更 |
| POST | `/api/program/channels` | 複数チャンネルの現在番組情報を一括取得 |
