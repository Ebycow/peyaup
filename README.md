# Discord配信停止死活監視Botなどなど

特定のDiscordユーザ1名を監視し、以下のどちらかが発生したときに通知チャンネルへアラートを送るBotです。

- Go Live（配信）がOFFになった
- VCから離脱した

`DEBOUNCE_MS` の間に配信が戻った場合は通知しません。
また、同一停止状態での重複通知を抑止します。

加えて、グローバルスラッシュコマンド `/spin` でギルド絵文字を使った `3x3` スロットを実行できます。

## 1. 必要なBot権限

- `Guilds`
- `GuildVoiceStates`
- 通知先チャンネルの送信権限
- `/spin` を使うチャンネルへの送信権限
- Bot招待時に `applications.commands` スコープ

## 2. セットアップ

```bash
cp .env.example .env
# .env を編集して値を設定
npm install
npm run build
```

## 3. ローカル実行

```bash
npm run dev
```

## 4. テスト

```bash
npm test
```

## 5. Docker Compose実行

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

## 6. 環境変数

- `DISCORD_TOKEN` (必須): Botトークン
- `GUILD_ID` (必須): 監視対象Guild ID
- `WATCH_USER_ID` (必須): 監視対象ユーザID
- `MENTION_USER_ID` (任意): 通知時にメンションするユーザID（未指定時は `WATCH_USER_ID`）
- `INCIDENT_CHANNEL_ID` (必須): 通知先チャンネルID
- `DEBOUNCE_MS` (任意): 瞬断吸収時間（ms、デフォルト `15000`）

## 7. 通知仕様

- 起動時に監視対象が停止状態なら即通知
- 停止通知のみ送信（復旧通知なし）
- 停止状態継続中の重複通知は送信しない

## 8. `/spin` 仕様

- ローカルスラッシュコマンド: `/spin`, `/spin-rate`（`GUILD_ID` のギルドに登録）
- 同名のグローバルコマンドが残っている場合は重複表示回避のため起動時に削除
- 実行場所: ギルド内のみ（DM非対応）
- 使用絵文字: 実行ギルドに存在するカスタム絵文字
- 盤面: `3x3`
- 抽選: 全9マス独立の完全ランダム（重みなし）
- 演出: 列ごとに約1秒遅延で停止し、同一メッセージを更新
- 当選判定: `8ライン`（横3 + 縦3 + 斜め2）
- ギルド絵文字が0件の場合: 実行不可メッセージを返して終了
- `/spin-rate` は、そのギルドの絵文字数を使った `/spin` 当選確率を表示
