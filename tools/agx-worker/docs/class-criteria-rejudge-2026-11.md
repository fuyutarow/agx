# 分類の基準の再判定（2026-11-22）

## 結論

基準の文では、調査を上げることと、軽い読み比べを下に残すことを同時に満たせなかった。調査の ticket は書き手が min_class で宣言する。

基準の文（`ROUTING_OBJECTIVE` と 3 クラスの criterion）は変えていない。代わりに、1 位と 2 位の確率の差が 0.15 未満のとき、routing が stderr に 1 行出して `min_class` の書き方を示す。行の選択は変えない。

## きっかけ

soks の一次資料サーベイの ticket（icd-* 7 本）が、すべて mechanical か localized に分類され、haiku の行に振られた。確率はほぼ平らで（mechanical 0.29〜0.41、localized 0.23〜0.37、cross_module 0.11〜0.23）、同じ ticket でも回によって分類が変わった。ticket の本文は切り詰められていなかった。今の基準の文はコード変更の語彙だけで書かれており、サーベイに当たる基準がない。

## 方法

- 対象は routing journal（`routing.jsonl` と `routing-2026-11-21.jsonl`）の、再現できる入力を持つ ticket 40 本。同じ `ticket_sha256` は最新の 1 件。
- `audit.input` をそのまま（今の基準）と、instructions と 3 クラスの criterion だけ差し替えたもの（候補）で、Jev に 2 回ずつ送った。routing journal と jev-usage には書いていない。
- 返却の 3 つ（split、uncheckable、contradiction）の文は変えていない。
- 「今の基準」は案ごとに流し直したので、今の基準の数字は案の間で少し違う。
- ticket の種類は writes と本文から機械的に付けた。コード変更は 4 本だけで、その層は判定できていない。
- 受け入れの記録は `agx worker ls --json --all` の judgment を `ticket_sha256` で結んだ。過去の拒否はほぼ全部が sandbox と hook の失敗で、行の能力の不足を示さない。上のクラスに上げると受け入れが増えるとは、この記録からは言えない。
- 過去の run の token による費用の概算は出していない。

## 採否の線

- icd-* はすべて cross_module。
- haiku の行で受け入れ済みの 11 本は、今の判定（mechanical）から動かない。
- 今 cross_module の ticket は cross_module のまま。
- 調査のほかに上がる検査・読みの ticket は 3 本まで（案 3 で追加）。

## 閾値 0.15 の根拠

今の基準で、1 位と 2 位の差が 0.15 未満だったのは 80 回のうち 30 回で、内訳はほぼ soks の調査だった。測定 1 回分の値である。`class_margin` の記録がたまったら、通知が出た ticket のうち書き手が `min_class` を足した割合を見て直す。誰も足さないなら通知を消す。

## 案 1: 能力の語彙で書き直す（検査の有無を含む）。不合格

- instructions: Purpose: classify this ticket by the capability its worker needs, whatever the kind of work (code, research, documents, checks). Use mechanical when the ticket states both what to produce and a check a machine can decide, localized when the worker must work out how inside one bounded area and the ticket states how success is told, and cross_module when the worker must reconcile several independent parts or sources or must design the check itself. Return the ticket only when it cannot be done as written. Do not choose a worker.
- mechanical: Classify only the ticket: choose mechanical only when the ticket states exactly what to produce or change and also states a check a machine can decide (a command, or a literal expected result), so the worker designs neither the result nor the check.
- localized: Choose localized only when the worker must work out how to reach the outcome, the work stays inside one bounded area (one module, one document, or one source), and the ticket states a check or refutation condition that tells whether it succeeded.
- cross_module: Choose cross_module only when the outcome requires reconciling several independent parts or sources (modules, public interfaces, documents, primary sources, or an existing corpus), or the ticket states no check a machine can decide so the worker must design how its result is verified.

haiku で受け入れ済みの 11 本のうち mechanical のままは 3 本。検査が書かれていない軽い読みの仕事まで上がった。

### 対象

40 本（routing journal にある、再現できる入力を持つ ticket。同じ ticket は最新の 1 件）
repo: soks 16, (tmp) 8, coralbase 8, standard-skills 4, firedancer 3, agx 1
種類（writes と本文からの機械的な分類）: 調査 16, 検査・読み 15, コード 4, その他 4, 文書 1

### 1. 分類の変化（各基準の 1 回目どうしの比較）

全体: 上がる 26, 同じ 11, 下がる 3

- repo=(tmp): 同じ 5, 上がる 2, 下がる 1
- repo=coralbase: 同じ 5, 下がる 2, 上がる 1
- repo=standard-skills: 上がる 4
- repo=firedancer: 上がる 3
- repo=soks: 上がる 16
- repo=agx: 同じ 1
- kind=文書: 上がる 1
- kind=検査・読み: 同じ 7, 上がる 7, 下がる 1
- kind=コード: 下がる 2, 同じ 1, 上がる 1
- kind=調査: 上がる 16
- kind=その他: 同じ 3, 上がる 1

### 判定の分布（1 回目）

今の基準: mechanical 27, cross_module 10, localized 3
候補の基準: cross_module 29, mechanical 7, localized 4
揺れ（同じ入力の 2 回でクラスが違う）: 今 3/40 (8%) / 候補 1/40 (3%)

### 2. 最も安い行に行く割合（mechanical か localized = TB4 の線 15 以下。haiku が通る線）

全体: 今 30/40 (75%) → 候補 11/40 (28%)

- 文書: 今 1/1 (100%) → 候補 0/1 (0%)
- 検査・読み: 今 11/15 (73%) → 候補 9/15 (60%)
- コード: 今 1/4 (25%) → 候補 2/4 (50%)
- 調査: 今 16/16 (100%) → 候補 0/16 (0%)
- その他: 今 1/4 (25%) → 候補 0/4 (0%)
  mechanical だけ: 今 27/40 (68%) → 候補 7/40 (18%)

### 3. 1 位と 2 位の確率の差（全 2 回ぶん）

今: min 0.00 / p25 0.08 / median 0.30 / p75 0.53 / max 0.78
候補: min 0.03 / p25 0.21 / median 0.75 / p75 0.90 / max 0.93
差が 0.15 未満: 今 30/80 (38%) / 候補 13/80 (16%)

### 4. 最大の確率と uncheckable

最大の確率 今: min 0.28 / p25 0.35 / median 0.55 / p75 0.73 / max 0.88
最大の確率 候補: min 0.35 / p25 0.56 / median 0.85 / p75 0.94 / max 0.96
uncheckable が 2 位以内（1 回目）: 今 0/40 (0%) / 候補 0/40 (0%)
返却（split/uncheckable/contradiction）が 1 位: 今 / 候補

### 5a. soks の icd-*

### 5b. haiku の行で受け入れられた run を持つ ticket

該当 11 本

- standard-skills/revise-reader-a.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- standard-skills/revise-reader-b.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- firedancer/r10-verify-prop4-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- firedancer/r5-generators-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- (tmp)/br-migrate-skills-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- (tmp)/br-migrate-statusline-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- coralbase/test-unique-detection-1120.md [その他]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- standard-skills/revise-device-reader-after.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- standard-skills/revise-device-reader-before.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- agx/sandbox-probe-1122.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical

### 6. 受け入れの結果が分かる ticket（journal の ticket と run を ticket の sha256 で結んだもの）

結べた run: 32 件（ticket 23 本）

- 今 mechanical: 受け入れ 11/19 (58%)
- 今 localized: 受け入れ 0/1 (0%)
- 今 cross_module: 受け入れ 6/12 (50%)
- 候補 mechanical: 受け入れ 6/8 (75%)
- 候補 localized: 受け入れ 4/6 (67%)
- 候補 cross_module: 受け入れ 7/18 (39%)
  候補で上がった ticket の run:
- (tmp)/simplify-audit-1120.md row=haiku-low reject: never started: sandbox dependency socat was missing on the rebuilt mac
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no work done: sandbox refused every Bash call (Failed to create bridge
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no audit done: sandbox bridge sockets failed again in the dotfiles wor
- standard-skills/revise-reader-a.md row=haiku-low accept: v1:none:読み手の試験（concept 2611.8 の説明段落）。答えは result.md。file の変更なし。unit=dia
- standard-skills/revise-reader-b.md row=haiku-low accept: v1:none:読み手の試験（concept 2611.9 の説明段落）。答えは result.md。file の変更なし。unit=dia
- firedancer/r10-verify-prop4-1120.md row=haiku-low reject: v1:none:soks-govern の hook で道具を使えず終了。成果なし。unit=diagnostic violations=n
- firedancer/r10-verify-prop4-1120.md row=haiku-low accept: v1:none:命題 4 の独立の導き直し。結果は run の result.md。repo の変更なし。unit=theory viola
- firedancer/r5-generators-1120.md row=haiku-low reject: v1:none:soks-govern の hook が全部の道具を拒み、1 行も読めずに終了。成果なし。unit=diagnostic v
- firedancer/r5-generators-1120.md row=haiku-low accept: v1:none:生成器の読み。項目 1〜4 は行番号つき、項目 5 は 15 件中 0 件で未達。結果は run の result.md。r
- firedancer/unique-rep-rule-1121.md row=haiku-medium reject: v1:none:sandbox の Bash の初期化の失敗で計数は走らず。変更は未検証で、対象の code も計数の script と違っ
- (tmp)/br-migrate-tools-shared-1120.md row=haiku-low reject: sandbox init failed (Failed to create bridge sockets); no source chang
- (tmp)/br-migrate-tools-shared-1120.md row=haiku-low accept: accepted on coordinator verification; full gate:land runs at integrati
- coralbase/test-unique-detection-1120.md row=haiku-low reject: partial: coverage step done for all 274 files (files.tsv), classificat
- coralbase/test-unique-detection-1120.md row=haiku-low accept: steps 1,2,4,5 by worker: 274 files, files.tsv+classification+report.md
- standard-skills/revise-device-reader-after.md row=haiku-low accept: v1:none:reader check of a prompt revision, no research finding. unit=a
- standard-skills/revise-device-reader-before.md row=haiku-low accept: v1:none:reader check of a prompt revision, no research finding. unit=a

### 全 ticket

- (tmp)/br-migrate-agents-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.39/0.45 | 候補 cross_module/cross_module m=0.03/0.07
- (tmp)/br-migrate-disk-reclaim-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.29/0.30 | 候補 mechanical/mechanical m=0.03/0.12
- (tmp)/br-migrate-scripts-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.16/0.17 | 候補 mechanical/mechanical m=0.19/0.20
- (tmp)/br-migrate-skills-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.59/0.50 | 候補 mechanical/mechanical m=0.53/0.49
- (tmp)/br-migrate-statusline-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.50/0.62 | 候補 mechanical/mechanical m=0.13/0.08
- (tmp)/br-migrate-tools-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.39/0.39 | 候補 cross_module/mechanical m=0.09/0.09
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.53/0.49 | 候補 localized/localized m=0.27/0.19
- (tmp)/simplify-audit-1120.md [文書] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.47/0.53 | 候補 cross_module/cross_module m=0.71/0.77
- agx/sandbox-probe-1122.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.70/0.62 | 候補 mechanical/mechanical m=0.91/0.89
- coralbase/core-api-names-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.16/0.14 | 候補 cross_module/cross_module m=0.52/0.52
- coralbase/mise-simplify-review-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.74/0.75 | 候補 cross_module/cross_module m=0.87/0.85
- coralbase/prover-pinned-framework-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.70/0.70 | 候補 cross_module/cross_module m=0.64/0.61
- coralbase/read-tree-follows-alpha-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.49/0.43 | 候補 mechanical/mechanical m=0.72/0.74
- coralbase/schema-registry-0-spec-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.22/0.17 | 候補 cross_module/cross_module m=0.61/0.60
- coralbase/sponsor-all-writes-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.71/0.69 | 候補 cross_module/cross_module m=0.83/0.87
- coralbase/test-unique-detection-1120.md [その他] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.75/0.68 | 候補 cross_module/cross_module m=0.12/0.10
- coralbase/ws-trunk-guard-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.76/0.76 | 候補 mechanical/mechanical m=0.34/0.40
- firedancer/r10-verify-prop4-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.25/0.11 | 候補 localized/localized m=0.15/0.15
- firedancer/r5-generators-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.58/0.60 | 候補 cross_module/cross_module m=0.43/0.40
- firedancer/unique-rep-rule-1121.md [コード] 記録 localized(haiku-medium) | 今 localized/localized m=0.26/0.38 | 候補 cross_module/cross_module m=0.03/0.05
- soks/ddia-roa-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.78/0.77 | 候補 cross_module/cross_module m=0.91/0.93
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.02/0.05 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.13/0.03 | 候補 cross_module/cross_module m=0.93/0.93
- soks/icd-exit-sorting.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.06/0.01 | 候補 cross_module/cross_module m=0.86/0.88
- soks/icd-exit-sorting.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.11/0.04 | 候補 cross_module/cross_module m=0.91/0.89
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.04/0.07 | 候補 cross_module/cross_module m=0.90/0.90
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.08/0.03 | 候補 cross_module/cross_module m=0.93/0.91
- soks/icd-mechanism.md [調査] 記録 localized(haiku-medium) | 今 localized/mechanical m=0.07/0.06 | 候補 cross_module/cross_module m=0.86/0.81
- soks/icd-mechanism.md [調査] 記録 mechanical(haiku-low) | 今 localized/mechanical m=0.05/0.08 | 候補 cross_module/cross_module m=0.90/0.88
- soks/icd-paralogy-kuhn.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.02/0.05 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-paralogy-kuhn.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.03/0.09 | 候補 cross_module/cross_module m=0.93/0.93
- soks/icd-regcomp-lockin.md [調査] 記録 localized(haiku-medium) | 今 mechanical/localized m=0.06/0.01 | 候補 cross_module/cross_module m=0.91/0.90
- soks/icd-regcomp-lockin.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.11/0.02 | 候補 cross_module/cross_module m=0.91/0.91
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.10/0.00 | 候補 cross_module/cross_module m=0.91/0.91
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.03/0.11 | 候補 cross_module/cross_module m=0.89/0.87
- soks/river-25pct-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.49/0.55 | 候補 cross_module/cross_module m=0.75/0.78
- standard-skills/revise-device-reader-after.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.35/0.35 | 候補 cross_module/cross_module m=0.14/0.17
- standard-skills/revise-device-reader-before.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.43/0.38 | 候補 cross_module/cross_module m=0.15/0.21
- standard-skills/revise-reader-a.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.25/0.30 | 候補 localized/localized m=0.72/0.57
- standard-skills/revise-reader-b.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.46/0.33 | 候補 localized/localized m=0.75/0.67

## 案 2: 能力の語彙で書き直す（手順の有無で切る）。不合格

- instructions: Purpose: classify this ticket by the capability its worker needs, whatever the kind of work (code, research, documents, checks). Use mechanical when the worker follows steps or produces a result the ticket already states, localized when the worker must decide how inside one bounded area, and cross_module when the worker must find and reconcile several independent parts or sources that the ticket does not hand over. Return the ticket only when it cannot be done as written. Do not choose a worker.
- mechanical: Classify only the ticket: choose mechanical only when the ticket states the steps to follow or the exact result to produce, and success is told by a stated check or by the result being present in a stated place, so the worker follows the ticket rather than deciding an approach.
- localized: Choose localized only when the worker must decide how to reach the outcome and the work stays inside one bounded area that the ticket names (one module, one document, one source, or one stated list of files).
- cross_module: Choose cross_module only when the outcome requires finding and reconciling several independent parts or sources that the ticket does not hand over: modules or public interfaces that must change together, primary sources to locate and compare, or an existing corpus the result must be integrated with.

今 cross_module のコード変更 6 本が mechanical に下がった。手順を細かく書いた ticket は、module をまたぐ変更でも mechanical と読まれた。

### 対象

40 本（routing journal にある、再現できる入力を持つ ticket。同じ ticket は最新の 1 件）
repo: soks 16, (tmp) 8, coralbase 8, standard-skills 4, firedancer 3, agx 1
種類（writes と本文からの機械的な分類）: 調査 16, 検査・読み 15, コード 4, その他 4, 文書 1

### 1. 分類の変化（各基準の 1 回目どうしの比較）

全体: 上がる 20, 同じ 13, 下がる 7

- repo=(tmp): 同じ 4, 下がる 3, 上がる 1
- repo=coralbase: 同じ 5, 下がる 3
- repo=standard-skills: 上がる 2, 同じ 2
- repo=firedancer: 上がる 1, 同じ 1, 下がる 1
- repo=soks: 上がる 16
- repo=agx: 同じ 1
- kind=文書: 上がる 1
- kind=検査・読み: 同じ 9, 上がる 3, 下がる 3
- kind=コード: 下がる 3, 同じ 1
- kind=調査: 上がる 16
- kind=その他: 同じ 3, 下がる 1

### 判定の分布（1 回目）

今の基準: mechanical 27, cross_module 10, localized 3
候補の基準: cross_module 21, mechanical 16, localized 3
揺れ（同じ入力の 2 回でクラスが違う）: 今 2/40 (5%) / 候補 0/40 (0%)

### 2. 最も安い行に行く割合（mechanical か localized = TB4 の線 15 以下。haiku が通る線）

全体: 今 30/40 (75%) → 候補 19/40 (48%)

- 文書: 今 1/1 (100%) → 候補 0/1 (0%)
- 検査・読み: 今 11/15 (73%) → 候補 14/15 (93%)
- コード: 今 1/4 (25%) → 候補 3/4 (75%)
- 調査: 今 16/16 (100%) → 候補 0/16 (0%)
- その他: 今 1/4 (25%) → 候補 2/4 (50%)
  mechanical だけ: 今 27/40 (68%) → 候補 16/40 (40%)

### 3. 1 位と 2 位の確率の差（全 2 回ぶん）

今: min 0.00 / p25 0.07 / median 0.32 / p75 0.54 / max 0.77
候補: min 0.02 / p25 0.67 / median 0.77 / p75 0.92 / max 1.00
差が 0.15 未満: 今 30/80 (38%) / 候補 4/80 (5%)

### 4. 最大の確率と uncheckable

最大の確率 今: min 0.27 / p25 0.35 / median 0.60 / p75 0.73 / max 0.88
最大の確率 候補: min 0.46 / p25 0.82 / median 0.88 / p75 0.96 / max 1.00
uncheckable が 2 位以内（1 回目）: 今 1/40 (3%) / 候補 0/40 (0%)
返却（split/uncheckable/contradiction）が 1 位: 今 / 候補

### 5a. soks の icd-*

### 5b. haiku の行で受け入れられた run を持つ ticket

該当 11 本

- standard-skills/revise-reader-a.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- standard-skills/revise-reader-b.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- firedancer/r10-verify-prop4-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 localized/localized
- firedancer/r5-generators-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-skills-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-statusline-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- coralbase/test-unique-detection-1120.md [その他]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- standard-skills/revise-device-reader-after.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- standard-skills/revise-device-reader-before.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- agx/sandbox-probe-1122.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical

### 6. 受け入れの結果が分かる ticket（journal の ticket と run を ticket の sha256 で結んだもの）

結べた run: 32 件（ticket 23 本）

- 今 mechanical: 受け入れ 11/19 (58%)
- 今 localized: 受け入れ 0/1 (0%)
- 今 cross_module: 受け入れ 6/12 (50%)
- 候補 mechanical: 受け入れ 13/22 (59%)
- 候補 localized: 受け入れ 3/4 (75%)
- 候補 cross_module: 受け入れ 1/6 (17%)
  候補で上がった ticket の run:
- (tmp)/simplify-audit-1120.md row=haiku-low reject: never started: sandbox dependency socat was missing on the rebuilt mac
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no work done: sandbox refused every Bash call (Failed to create bridge
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no audit done: sandbox bridge sockets failed again in the dotfiles wor
- standard-skills/revise-reader-a.md row=haiku-low accept: v1:none:読み手の試験（concept 2611.8 の説明段落）。答えは result.md。file の変更なし。unit=dia
- standard-skills/revise-reader-b.md row=haiku-low accept: v1:none:読み手の試験（concept 2611.9 の説明段落）。答えは result.md。file の変更なし。unit=dia
- firedancer/r10-verify-prop4-1120.md row=haiku-low reject: v1:none:soks-govern の hook で道具を使えず終了。成果なし。unit=diagnostic violations=n
- firedancer/r10-verify-prop4-1120.md row=haiku-low accept: v1:none:命題 4 の独立の導き直し。結果は run の result.md。repo の変更なし。unit=theory viola

### 全 ticket

- (tmp)/br-migrate-agents-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.45/0.47 | 候補 mechanical/mechanical m=0.40/0.50
- (tmp)/br-migrate-disk-reclaim-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.31/0.31 | 候補 mechanical/mechanical m=0.76/0.82
- (tmp)/br-migrate-scripts-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.17/0.25 | 候補 mechanical/mechanical m=0.71/0.74
- (tmp)/br-migrate-skills-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.54/0.51 | 候補 mechanical/mechanical m=0.77/0.80
- (tmp)/br-migrate-statusline-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.61/0.54 | 候補 mechanical/mechanical m=0.84/0.85
- (tmp)/br-migrate-tools-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.41/0.38 | 候補 mechanical/mechanical m=0.67/0.63
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.55/0.56 | 候補 mechanical/mechanical m=0.74/0.79
- (tmp)/simplify-audit-1120.md [文書] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.42/0.31 | 候補 cross_module/cross_module m=0.72/0.69
- agx/sandbox-probe-1122.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.56/0.58 | 候補 mechanical/mechanical m=1.00/1.00
- coralbase/core-api-names-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.11/0.22 | 候補 mechanical/mechanical m=0.15/0.32
- coralbase/mise-simplify-review-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.71/0.76 | 候補 cross_module/cross_module m=0.75/0.71
- coralbase/prover-pinned-framework-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.70/0.66 | 候補 cross_module/cross_module m=0.44/0.44
- coralbase/read-tree-follows-alpha-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.43/0.49 | 候補 mechanical/mechanical m=0.92/0.93
- coralbase/schema-registry-0-spec-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.31/0.22 | 候補 cross_module/cross_module m=0.58/0.53
- coralbase/sponsor-all-writes-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.77/0.63 | 候補 cross_module/cross_module m=0.77/0.65
- coralbase/test-unique-detection-1120.md [その他] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.69/0.71 | 候補 mechanical/mechanical m=0.84/0.86
- coralbase/ws-trunk-guard-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.76/0.66 | 候補 mechanical/mechanical m=0.73/0.72
- firedancer/r10-verify-prop4-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.14/0.18 | 候補 localized/localized m=0.06/0.02
- firedancer/r5-generators-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.64/0.63 | 候補 mechanical/mechanical m=0.04/0.05
- firedancer/unique-rep-rule-1121.md [コード] 記録 localized(haiku-medium) | 今 localized/localized m=0.35/0.43 | 候補 mechanical/mechanical m=0.38/0.44
- soks/ddia-roa-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.77/0.74 | 候補 cross_module/cross_module m=0.76/0.74
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.06/0.03 | 候補 cross_module/cross_module m=0.94/0.94
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.03/0.03 | 候補 cross_module/cross_module m=0.96/0.96
- soks/icd-exit-sorting.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.09/0.05 | 候補 cross_module/cross_module m=0.88/0.90
- soks/icd-exit-sorting.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.00/0.05 | 候補 cross_module/cross_module m=0.94/0.94
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.07/0.14 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.06/0.04 | 候補 cross_module/cross_module m=0.96/0.94
- soks/icd-mechanism.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.03/0.04 | 候補 cross_module/cross_module m=0.86/0.86
- soks/icd-mechanism.md [調査] 記録 mechanical(haiku-low) | 今 localized/localized m=0.04/0.05 | 候補 cross_module/cross_module m=0.96/0.96
- soks/icd-paralogy-kuhn.md [調査] 記録 localized(haiku-medium) | 今 localized/mechanical m=0.04/0.09 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-paralogy-kuhn.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/localized m=0.04/0.00 | 候補 cross_module/cross_module m=0.96/0.96
- soks/icd-regcomp-lockin.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.02/0.10 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-regcomp-lockin.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.08/0.00 | 候補 cross_module/cross_module m=0.96/0.96
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.07/0.04 | 候補 cross_module/cross_module m=0.90/0.92
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.09/0.07 | 候補 cross_module/cross_module m=0.96/0.96
- soks/river-25pct-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.48/0.49 | 候補 cross_module/cross_module m=0.55/0.45
- standard-skills/revise-device-reader-after.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.48/0.47 | 候補 mechanical/mechanical m=0.69/0.74
- standard-skills/revise-device-reader-before.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.35/0.39 | 候補 mechanical/mechanical m=0.60/0.71
- standard-skills/revise-reader-a.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.32/0.24 | 候補 localized/localized m=0.72/0.66
- standard-skills/revise-reader-b.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.53/0.39 | 候補 localized/localized m=0.75/0.75

## 案 3: 今の文に資料の突き合わせを足すだけ。不合格

mechanical と localized の文は変えない。

- instructions: Purpose: classify this ticket by the requirement it imposes. Use mechanical for an edit whose check is already stated, localized for a behavior fix inside one module, and cross_module when an invariant, public API, or behavior across modules must change, or when several independent sources the ticket does not hand over must be found and reconciled. Return the ticket only when it cannot be done as written. Do not choose a worker.
- cross_module: Choose cross_module only when an invariant, a public API, or behavior spanning modules must change, or when the worker must find and reconcile several independent sources that the ticket does not hand over.

下がった ticket は 0、icd-* と今 cross_module の 6 本は線を満たした。haiku で受け入れ済みの 11 本のうち 5 本が cross_module に上がり、検査・読みは 4 本上がった。足した節は、複数のものを読んで比べる軽い仕事も拾う。

### 対象

40 本（routing journal にある、再現できる入力を持つ ticket。同じ ticket は最新の 1 件）
repo: soks 16, (tmp) 8, coralbase 8, standard-skills 4, firedancer 3, agx 1
種類（writes と本文からの機械的な分類）: 調査 16, 検査・読み 15, コード 4, その他 4, 文書 1

### 1. 分類の変化（各基準の 1 回目どうしの比較）

全体: 上がる 23, 同じ 17

- repo=(tmp): 同じ 7, 上がる 1
- repo=coralbase: 同じ 6, 上がる 2
- repo=standard-skills: 同じ 2, 上がる 2
- repo=firedancer: 上がる 2, 同じ 1
- repo=soks: 上がる 16
- repo=agx: 同じ 1
- kind=文書: 上がる 1
- kind=検査・読み: 同じ 11, 上がる 4
- kind=コード: 同じ 4
- kind=調査: 上がる 16
- kind=その他: 同じ 2, 上がる 2

### 判定の分布（1 回目）

今の基準: mechanical 29, cross_module 9, localized 2
候補の基準: cross_module 32, mechanical 7, localized 1
揺れ（同じ入力の 2 回でクラスが違う）: 今 3/40 (8%) / 候補 1/40 (3%)

### 2. 最も安い行に行く割合（mechanical か localized = TB4 の線 15 以下。haiku が通る線）

全体: 今 31/40 (78%) → 候補 8/40 (20%)

- 文書: 今 1/1 (100%) → 候補 0/1 (0%)
- 検査・読み: 今 11/15 (73%) → 候補 7/15 (47%)
- コード: 今 1/4 (25%) → 候補 1/4 (25%)
- 調査: 今 16/16 (100%) → 候補 0/16 (0%)
- その他: 今 2/4 (50%) → 候補 0/4 (0%)
  mechanical だけ: 今 29/40 (73%) → 候補 7/40 (18%)

### 3. 1 位と 2 位の確率の差（全 2 回ぶん）

今: min 0.00 / p25 0.08 / median 0.33 / p75 0.52 / max 0.80
候補: min 0.01 / p25 0.42 / median 0.72 / p75 0.98 / max 1.00
差が 0.15 未満: 今 30/80 (38%) / 候補 7/80 (9%)

### 4. 最大の確率と uncheckable

最大の確率 今: min 0.28 / p25 0.36 / median 0.56 / p75 0.72 / max 0.90
最大の確率 候補: min 0.42 / p25 0.66 / median 0.84 / p75 0.99 / max 1.00
uncheckable が 2 位以内（1 回目）: 今 1/40 (3%) / 候補 0/40 (0%)
返却（split/uncheckable/contradiction）が 1 位: 今 / 候補

### 5a. soks の icd-*

### 5b. haiku の行で受け入れられた run を持つ ticket

該当 11 本

- standard-skills/revise-reader-a.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- standard-skills/revise-reader-b.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- firedancer/r10-verify-prop4-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- firedancer/r5-generators-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-skills-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- (tmp)/br-migrate-statusline-1120.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical
- coralbase/test-unique-detection-1120.md [その他]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- standard-skills/revise-device-reader-after.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/mechanical
- standard-skills/revise-device-reader-before.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 cross_module/cross_module
- agx/sandbox-probe-1122.md [検査・読み]: 記録 mechanical / 今 mechanical/mechanical → 候補 mechanical/mechanical

### 6. 受け入れの結果が分かる ticket（journal の ticket と run を ticket の sha256 で結んだもの）

結べた run: 32 件（ticket 23 本）

- 今 mechanical: 受け入れ 11/20 (55%)
- 今 localized: 受け入れ 0/1 (0%)
- 今 cross_module: 受け入れ 6/11 (55%)
- 候補 mechanical: 受け入れ 6/8 (75%)
- 候補 localized: 受け入れ 0/1 (0%)
- 候補 cross_module: 受け入れ 11/23 (48%)
  候補で上がった ticket の run:
- (tmp)/simplify-audit-1120.md row=haiku-low reject: never started: sandbox dependency socat was missing on the rebuilt mac
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no work done: sandbox refused every Bash call (Failed to create bridge
- (tmp)/simplify-audit-1120.md row=haiku-low reject: no audit done: sandbox bridge sockets failed again in the dotfiles wor
- firedancer/r10-verify-prop4-1120.md row=haiku-low reject: v1:none:soks-govern の hook で道具を使えず終了。成果なし。unit=diagnostic violations=n
- firedancer/r10-verify-prop4-1120.md row=haiku-low accept: v1:none:命題 4 の独立の導き直し。結果は run の result.md。repo の変更なし。unit=theory viola
- firedancer/r5-generators-1120.md row=haiku-low reject: v1:none:soks-govern の hook が全部の道具を拒み、1 行も読めずに終了。成果なし。unit=diagnostic v
- firedancer/r5-generators-1120.md row=haiku-low accept: v1:none:生成器の読み。項目 1〜4 は行番号つき、項目 5 は 15 件中 0 件で未達。結果は run の result.md。r
- coralbase/test-unique-detection-1120.md row=haiku-low reject: partial: coverage step done for all 274 files (files.tsv), classificat
- coralbase/test-unique-detection-1120.md row=haiku-low accept: steps 1,2,4,5 by worker: 274 files, files.tsv+classification+report.md
- coralbase/core-api-names-1120.md row=sonnet-high reject: codemod and sponsor allow-list move kept and continued by coordinator.
- standard-skills/revise-device-reader-after.md row=haiku-low accept: v1:none:reader check of a prompt revision, no research finding. unit=a
- standard-skills/revise-device-reader-before.md row=haiku-low accept: v1:none:reader check of a prompt revision, no research finding. unit=a

### 全 ticket

- (tmp)/br-migrate-agents-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.43/0.37 | 候補 cross_module/cross_module m=0.56/0.52
- (tmp)/br-migrate-disk-reclaim-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.33/0.26 | 候補 mechanical/mechanical m=0.21/0.14
- (tmp)/br-migrate-scripts-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.13/0.21 | 候補 cross_module/cross_module m=0.29/0.27
- (tmp)/br-migrate-skills-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.52/0.60 | 候補 mechanical/mechanical m=0.62/0.56
- (tmp)/br-migrate-statusline-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.66/0.58 | 候補 mechanical/mechanical m=0.57/0.55
- (tmp)/br-migrate-tools-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.43/0.47 | 候補 cross_module/cross_module m=0.47/0.42
- (tmp)/br-migrate-tools-shared-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.59/0.47 | 候補 mechanical/mechanical m=0.45/0.43
- (tmp)/simplify-audit-1120.md [文書] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.32/0.49 | 候補 cross_module/cross_module m=0.64/0.72
- agx/sandbox-probe-1122.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.57/0.52 | 候補 mechanical/mechanical m=0.41/0.49
- coralbase/core-api-names-1120.md [その他] 記録 cross_module(sonnet-high) | 今 mechanical/cross_module m=0.00/0.08 | 候補 cross_module/cross_module m=0.49/0.30
- coralbase/mise-simplify-review-1120.md [検査・読み] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.73/0.63 | 候補 cross_module/cross_module m=0.96/0.94
- coralbase/prover-pinned-framework-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.64/0.70 | 候補 cross_module/cross_module m=0.89/0.91
- coralbase/read-tree-follows-alpha-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.47/0.51 | 候補 cross_module/cross_module m=0.24/0.28
- coralbase/schema-registry-0-spec-1120.md [その他] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.24/0.23 | 候補 cross_module/cross_module m=0.74/0.70
- coralbase/sponsor-all-writes-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.71/0.68 | 候補 cross_module/cross_module m=0.98/0.96
- coralbase/test-unique-detection-1120.md [その他] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.74/0.68 | 候補 cross_module/cross_module m=0.21/0.02
- coralbase/ws-trunk-guard-1120.md [コード] 記録 cross_module(sonnet-high) | 今 cross_module/cross_module m=0.70/0.80 | 候補 cross_module/cross_module m=0.62/0.52
- firedancer/r10-verify-prop4-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.15/0.18 | 候補 cross_module/cross_module m=0.56/0.63
- firedancer/r5-generators-1120.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.58/0.62 | 候補 cross_module/cross_module m=0.60/0.60
- firedancer/unique-rep-rule-1121.md [コード] 記録 localized(haiku-medium) | 今 localized/localized m=0.49/0.29 | 候補 localized/localized m=0.30/0.40
- soks/ddia-roa-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.71/0.75 | 候補 cross_module/cross_module m=0.82/0.84
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 localized/mechanical m=0.04/0.01 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-collective-commons.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.02/0.06 | 候補 cross_module/cross_module m=0.98/1.00
- soks/icd-exit-sorting.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.02/0.08 | 候補 cross_module/cross_module m=0.97/0.98
- soks/icd-exit-sorting.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.10/0.07 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.01/0.03 | 候補 cross_module/cross_module m=0.96/0.98
- soks/icd-knowledge-positional.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.09/0.09 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-mechanism.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.00/0.07 | 候補 cross_module/cross_module m=0.97/0.98
- soks/icd-mechanism.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.12/0.04 | 候補 cross_module/cross_module m=1.00/0.98
- soks/icd-paralogy-kuhn.md [調査] 記録 localized(haiku-medium) | 今 mechanical/localized m=0.07/0.06 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-paralogy-kuhn.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.16/0.03 | 候補 cross_module/cross_module m=1.00/1.00
- soks/icd-regcomp-lockin.md [調査] 記録 localized(haiku-medium) | 今 mechanical/mechanical m=0.05/0.07 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-regcomp-lockin.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.13/0.14 | 候補 cross_module/cross_module m=1.00/1.00
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.13/0.06 | 候補 cross_module/cross_module m=0.98/0.98
- soks/icd-stake-state.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.02/0.04 | 候補 cross_module/cross_module m=1.00/0.98
- soks/river-25pct-survey.md [調査] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.48/0.47 | 候補 cross_module/cross_module m=0.85/0.89
- standard-skills/revise-device-reader-after.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.37/0.43 | 候補 cross_module/mechanical m=0.06/0.01
- standard-skills/revise-device-reader-before.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.40/0.31 | 候補 cross_module/cross_module m=0.12/0.15
- standard-skills/revise-reader-a.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.33/0.43 | 候補 mechanical/mechanical m=0.15/0.21
- standard-skills/revise-reader-b.md [検査・読み] 記録 mechanical(haiku-low) | 今 mechanical/mechanical m=0.52/0.41 | 候補 mechanical/mechanical m=0.30/0.35
