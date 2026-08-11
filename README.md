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
