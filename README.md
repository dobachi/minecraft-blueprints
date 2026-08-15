# minecraft-blueprints

Minecraft Bedrock の建築物を**相対座標の定義ファイル**として蓄積するコレクション。
アンカー（原点）を与えると絶対座標の実行計画に展開されるので、**同じ定義がどのワールドの
どの場所でも建つ**。

建築の実行そのものは [minecraft-claude](https://github.com/dobachi/minecraft-claude) の
MCP 環境が担当する。このリポジトリは「何を建てるか」だけを持つ。

## なぜファイルにするのか

チャットで「9x9 の家を建てて」と頼んで建った家は、その場限りで消える。座標を外に出して
ファイルにしておくと、

- **git で差分が読める** — 「窓を 1 段上げた」がレビューできる
- **失敗の知識が同居する** — 各ステップの `why:` に、そこで踏んだ罠を書いておける
- **着手前に検証できる** — 展開後の絶対座標を出力して、どこに何が置かれるか確認できる
- **別ワールドに持ち出せる** — `--at` を変えるだけ

## 使い方

初回のみ依存をインストールする。

```bash
npm install
```

建てたい場所を決めて、実行計画を出す。

```bash
node scripts/build-plan.js blueprints/starter-house.yaml --at 24 65 -258
```

```
starter-house v1 — 21 operations
anchor: (24, 65, -258)
  建物の北西角、床レベル

 1. 敷地クリア
    blocks  (24,65,-258) -> (32,71,-250)  minecraft:air
 2. 基礎
    blocks  (24,63,-258) -> (32,64,-250)  minecraft:stone mode=keep
 ...
```

**この時点では何も建たない。**計画を確認してから実行する。

### 出力形式

| `--format` | 用途 |
| --- | --- |
| `text`（既定） | 人間が読む。着手前のレビュー用 |
| `json` | MCP ツール呼び出しの配列。Claude Code がそのまま実行できる |
| `commands` | Bedrock の生コマンド列。手で貼るとき用 |

```bash
node scripts/build-plan.js blueprints/starter-house.yaml --at 100 70 -300 --format commands
```

### 実行

Claude Code に `--format json` の出力を渡すと、`minecraft-bedrock` MCP ツールで
順に実行できる。**スクリプトから直接 WebSocket に繋がないこと** — ポート 8001 は
Claude Code が起動した MCP サーバが握っているので衝突する。計画の生成と実行は分ける。

## 建てる場所の決め方

アンカーは各ブループリントの `anchor.description` が定義する（`starter-house` なら
「建物の北西角・床レベル」）。実際に建てる前に、

1. `player get_location` で現在地を確認する
2. `blocks get_top_solid_block` で予定地の地表高さを測る（**`y` は渡さない** — 理由は
   [docs/PITFALLS.md](docs/PITFALLS.md)）
3. 既存の建造物と重ならないことを確認する。**マルチプレイでは持ち主の許可を取る**

## ブループリントの書き方

```yaml
name: starter-house
version: 1
description: 一行で何か
anchor:
  description: 原点がどこを指すか（これが曖昧だと再現できない）
bounds:            # 占有範囲。範囲外の step があれば警告が出る
  min: [0, -2, 0]
  max: [10, 6, 8]
preconditions:     # 自動チェックはしない。人間と AI が読む前提条件
  - 地形の高低差が 2 以内であること
steps:
  - name: 基礎
    op: fill
    from: [0, -2, 0]
    to:   [8, -1, 8]
    block: minecraft:stone
    mode: keep
    why: なぜこうするのか。ここに罠を書き残す
todo:              # 未解決の課題
  - 傾斜屋根に変える案
```

### op の種類

| op | 意味 | 主なフィールド |
| --- | --- | --- |
| `fill` | 直方体を埋める | `from` / `to` / `block` / `mode` |
| `cube` | 箱を建てる（中空可） | `from` / `to` / `block` / `hollow` |
| `setblock` | 1 ブロックずつ置く | `at`（複数可） / `block` / `raw` |
| `command` | 生コマンド | `command`（`{x}` `{y}` `{z}` を展開） / `at` |

`mode` は `replace`（既定）/ `keep`（空気だけ埋める）/ `destroy` など。
`raw: true` を付けた `setblock` は生コマンド経由になる（ドアのように
ブロック ID をそのまま渡す必要があるもの向け）。

**座標はすべて相対**。絶対座標を書いた時点で再現性が失われる。

## 収録ブループリント

| 名前 | 内容 | 規模 |
| --- | --- | --- |
| `starter-house` | 9x9 の木造小屋。窓・天井照明・両開きドア・入口階段 | 約 440 ブロック / 23 操作 |
| `manor-house` | 13x13 の 3 階建て + 屋上テラス。物置・風呂・キッチン・ダイニング・寝室・BBQ、内部階段で全階接続 | 約 2,300 ブロック / 113 操作 |
| `manor-house-furniture` | 上に重ねる家具パック。**Another Furniture Add-On が必要** | 14 操作 |

### 追加パックの重ね方

`manor-house-furniture` は躯体を作らず、家具だけを上書きする差分パックです。
**本体と同じアンカー**を指定して、本体のあとに適用します。

```bash
node scripts/build-plan.js blueprints/manor-house.yaml           --at -117 69 -604
node scripts/build-plan.js blueprints/manor-house-furniture.yaml --at -117 69 -604
```

本体をコピーして家具入りの別ファイルを作ると、本体を直すたびに二重に直すことに
なるので分けています。アドオンのないワールドでは本体だけを使ってください
（`sf_afm:*` は構文エラーになり、家具が一つも置かれません）。

## 関連

- [docs/PITFALLS.md](docs/PITFALLS.md) — 実機で踏んだ落とし穴と回避策
- [minecraft-claude](https://github.com/dobachi/minecraft-claude) — 接続環境のセットアップ
