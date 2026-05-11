# cardbattle-js (deployment bundle)

## Render ranking persistence

Ranking data is stored in `accounts.json`.

For Render Free web services, local filesystem changes are lost on redeploy,
restart, and spin-down. That means rankings saved to `cardbattle-server/data`
can disappear.

Use one of these durable storage options:

- Paid Render web service + Persistent Disk
  - Recommended mount path: `/var/data`
  - Environment variable: `ACCOUNT_DATA_DIR=/var/data/cardbattle`
- A real database such as Render Postgres

After deploy, open:

`/api/ranking/storage_status`

Check that `likelyPersistent` is `true` and `accountCount` is not reset after a
restart/redeploy.


## 2026-01-22 更新（nogit最新版 → Git運用）

- `data/accounts.json` はレート/勝利数の永続データです。
- GitHub に commit するとデプロイ更新でリセットの原因になるため **commit 対象から除外**してください。
  - 本フォルダでは `.gitignore` で `data/accounts.json` を除外済みです。
  - 既に追跡済みの場合は、初回だけ以下を実行してください：
    - `git rm --cached data/accounts.json`
    - `git commit -m "chore: stop tracking accounts.json"`

Render 側で確実に残すなら Persistent Disk を利用し、`/data` を永続化してください。
