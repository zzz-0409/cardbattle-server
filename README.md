# cardbattle-js (deployment bundle)


## 2026-01-22 更新（nogit最新版 → Git運用）

- `data/accounts.json` はレート/勝利数の永続データです。
- GitHub に commit するとデプロイ更新でリセットの原因になるため **commit 対象から除外**してください。
  - 本フォルダでは `.gitignore` で `data/accounts.json` を除外済みです。
  - 既に追跡済みの場合は、初回だけ以下を実行してください：
    - `git rm --cached data/accounts.json`
    - `git commit -m "chore: stop tracking accounts.json"`

Render 側で確実に残すなら Persistent Disk を利用し、`/data` を永続化してください。
