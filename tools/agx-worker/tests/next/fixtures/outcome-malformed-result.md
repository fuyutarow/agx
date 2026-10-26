# migrate-benchmarks-leaderboard-2611-1026

状態: RETURN。実装と指定チェックを完了したが、`mise run commit --push` のpre-commit gateが `lint:ts` で拒否し、alphaへのcommit/pushは未完了。
Run ID: `6a188a10-a3f5-41b5-aafe-b766c1c72037`

## 変更

- `packages-2609/MLStableBenchmarks.jl` の追跡ファイル536件を `packages-2611/MLStableBenchmarks.jl` へコピー。
- `packages-2609/Leaderboard` の追跡ファイルを `packages-2611/Leaderboard` へコピー。2611側にあった雛形 `README.md` は2609側の追跡ツリーに無いため削除し、コピー先ツリーを一致させた。
- `mise.toml` の `leaderboard:ingest` / `leaderboard:view` を `packages-2611/Leaderboard` に変更。
- `envs/pkg-2611/Project.toml` に `MLStableBenchmarks` のpath dependencyとcompatを追加し、Julia Pkgで `Manifest.toml` を更新。
- コピー元/先SHA-256ペアmanifest: `migrate-benchmarks-leaderboard-2611-1026/sha256-pairs.txt`（536ペア、1072 file entries）。追跡ファイル一覧は `migrate-benchmarks-leaderboard-2611-1026/tracked-files.txt`。

## 検証

- SHA-256 manifest照合と両package treeの `diff -qr`: PASS、536ペア一致。テストで生成された `.pytest_cache` / `__pycache__` は除去し、再実行では生成を抑止。
- Leaderboard: `uv run --with pytest python -m pytest -p no:cacheprovider -q`: 13 passed。
- `mise run leaderboard:view`: exit 0、31 data rowsを出力。
- `mise run test:package-generation-paths`: PASS (`tracked_files=7038 current=0 historical=70 exceptions=36`)。
- Router path gate `test -f packages-2611/MLStableBenchmarks.jl/Project.toml && test -f packages-2611/Leaderboard/pyproject.toml`: PASS。
- Julia: 前runの引継ぎでは `Pkg.test("MLStableBenchmarks")` 全suite PASS。OpenML CSV不在による1件のskip/brokenと `STABLE_BENCHMARKS_DATA_ROOT` 未設定による実データ証跡テストskipは既存条件。`literature_verdict` の記録run smokeもcheckoutにrunが無いためskip。前runの保存stdoutは `arena_fullrun` 中で途切れ、最終summary/exit status自体はこのrunでは再取得していない。指示によりJulia suiteは再実行していない。
- `mise run commit -- -m "Migrate benchmark and leaderboard packages to packages-2611" --bookmark alpha --push -- mise.toml envs/pkg-2611/Project.toml envs/pkg-2611/Manifest.toml packages-2611/MLStableBenchmarks.jl packages-2611/Leaderboard`: exit 1。`fmt:staged` とruntime contract 21/21はPASS後、`lint:ts` が `packages-2611/MLStableBenchmarks.jl/scripts/relay_merge.ts` と `packages-2611/MLStableBenchmarks.jl/test/literature_schema.test.ts` の型lintを拒否。commit scriptは「nothing committed」と報告。

検証ログ・manifestはこのディレクトリ内の `julia-tests.log`, `leaderboard-tests.log`, `leaderboard-view.log`, `package-generation-paths.log`, `router-path-gate.log`, `copy-verification.log`, `commit-push.log`, `alpha-readback.log` に保存。

## alpha readback

`alpha`, `alpha@origin`, `@-` はすべて `6d83d974d658677466953bf054b545d08dac38c5` のまま。pushされたcommitは無い。

## 未決

バイト完全一致のコピーを保つ場合、上記2つのコピー済みTypeScriptファイルに対するlint範囲を狭める必要がある。ソースをlint適合させる場合はコピーのbyte-for-byte条件とSHA-256一致条件を緩める必要がある。この選択が解決するまでcommit/pushを再試行していない。

## Completion ACK

`xmsg send` を指定のClaude宛・現在の `CODEX_SESSION_ID` で1回呼び出した。30秒でツール呼び出しがyieldし、enqueue receiptを取得できていない。重複送信は行っていない。
