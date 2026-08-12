# LINO BROW 予約アプリ

## デプロイ手順（GitHub + Vercel）

1. GitHubで新しいリポジトリを作成（例: `lino-brow-booking`）
2. このフォルダの中身をすべてアップロード（`node_modules` フォルダは除く）
3. https://vercel.com にGitHubアカウントでログイン
4. 「Add New Project」→ 今作ったリポジトリを選択 → そのまま「Deploy」
5. 数十秒でURLが発行されます（例: `https://lino-brow-booking.vercel.app`）

## Supabase接続について

`src/supabaseClient.js` に接続情報が直接書かれています（Publishable keyは公開しても問題ない情報です）。
別のSupabaseプロジェクトに切り替える場合は、Vercelの「Environment Variables」で
`VITE_SUPABASE_URL` と `VITE_SUPABASE_KEY` を設定すれば、コードを直さず切り替えられます。

## 事前に必要なSupabaseテーブルSQL

```sql
create table app_data (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

alter table app_data enable row level security;

create policy "Allow public read/write"
on app_data for all
using (true)
with check (true);
```

## LINE通知の設定（3アカウント運用）

- **LINO BROW**（一般のお客様用）: 予約確認をお客様本人に送るだけ（webhook不要）
- **yoin° Beauty**（法人のお客様用）: 予約確認をお客様本人に送るだけ（webhook不要）
- **lino brow 予約通知**（スタッフ通知専用）: 法人・一般どちらの予約が入っても、登録済み全スタッフへ通知（webhookが必要）

### Vercelの環境変数

| 変数名 | 値 |
|---|---|
| `LINE_GENERAL_CHANNEL_ACCESS_TOKEN` | LINO BROWの「チャネルアクセストークン（長期）」 |
| `LINE_CORP_CHANNEL_ACCESS_TOKEN` | yoin° Beautyの「チャネルアクセストークン（長期）」 |
| `LINE_STAFF_CHANNEL_ACCESS_TOKEN` | lino brow 予約通知の「チャネルアクセストークン（長期）」 |
| `LINE_STAFF_CHANNEL_SECRET` | lino brow 予約通知の「Channel secret」 |
| `VITE_LIFF_ID_GENERAL` | LINO BROW側で作成したLIFF ID |
| `VITE_LIFF_ID_CORP` | yoin° Beauty側で作成したLIFF ID |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_KEY` | Supabaseの Publishable key |
| `CRON_SECRET` | 前日リマインド用（任意の文字列、推奨） |

### LINE Developersでのwebhook設定

**lino brow 予約通知**チャネルの「Messaging API設定」のみ:
- Webhook URL: `https://（VercelのURL）/api/line-webhook-staff`
- 「Webhookの利用」をオンにする

LINO BROW・yoin° Beautyの2アカウントは、webhookの設定は不要です（お客様への一方向のお知らせのみのため）。

### LIFFエンドポイントURL（LINO BROW・yoin° Beautyそれぞれで設定）

- LINO BROW側のLIFFアプリ: エンドポイントURLに `?account=general`
- yoin° Beauty側のLIFFアプリ: エンドポイントURLに `?account=corp`

### 仕組み

- スタッフへの通知: 法人・一般どちらの予約でも、「lino brow 予約通知」アカウントに登録されている全スタッフへ自動送信
- お客様への確認通知: お客様がどちらのアカウント経由でLIFFを開いたか（`?account=`）に応じて、対応するアカウントから本人へ自動送信（LINE連携が必須のため、予約したお客様には必ず送信されます）
- スタッフの登録は、「lino brow 予約通知」アカウントに何かメッセージを送るだけで自動登録（管理画面の「LINE通知」タブで確認・解除可能）

## LINE連携について

お客様は予約フォームの「お客様情報」入力画面で、LINE連携をしないと次のステップへ進めません（必須）。LINEアプリ内から `https://liff.line.me/（LIFF ID）` の形式のリンクで開いた場合は自動的に連携され、ブラウザから直接開いた場合は「LINEと連携する」ボタンからLINEログイン画面に進みます。

## 前日リマインド通知

毎日17:00（JST）に、翌日ご来店予定のお客様（LINE連携済みの方のみ）へ自動でリマインドメッセージを送信します。

- 実行内容: `api/send-reminders.js`
- 実行タイミング: `vercel.json` の cron 設定（UTC 08:00 = JST 17:00）
- 文面はコード内 `reminderText()` 関数で編集可能

### セキュリティ（任意）

`CRON_SECRET` という環境変数をVercelに追加すると、この関数が正規のCron実行以外から呼び出されるのを防げます（設定しなくても動作しますが、推奨です）。値は自分で決めた適当な文字列で構いません。