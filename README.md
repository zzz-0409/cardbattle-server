# cardbattle-js (deployment bundle)

## Render + GitHub account/ranking persistence

`accounts.json` can now be mirrored to GitHub so rankings, names, and dojo
progress survive Render restarts/redeploys even without a persistent disk.

Set these Render environment variables:

- Recommended: use a separate private data repository. If you use the same
  repository that Render auto-deploys from, every data commit can trigger a
  redeploy.
- `GILSYS_GITHUB_TOKEN`
  - GitHub fine-grained personal access token with `Contents: Read and write`
    permission for the target repository.
- `GILSYS_GITHUB_REPOSITORY`
  - Repository in `owner/repo` format.
- `GILSYS_GITHUB_BRANCH`
  - Optional. Defaults to `main`.
- `GILSYS_GITHUB_DATA_PATH`
  - Optional. Defaults to `data/accounts.json`.

Startup behavior:

- If the GitHub file exists, the server merges GitHub data with local
  `accounts.json` before opening the port.
- If the GitHub file does not exist and local accounts exist, the server creates
  it.
- Every local save is still immediate; GitHub writes are debounced in the
  background.
- If GitHub variables are missing, the server falls back to the old local/Render
  disk behavior.

After deploy, open:

`/api/ranking/storage_status`

Check `github.enabled`, `github.lastPull`, `github.lastPush`, and `accountCount`.

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
