# task-47 · 路径家族第 14/15 例（判据口径 + 挖出的产品侧 Windows-only bug）

**执行**：`plan03-belief` · 起点见 task-47 · 写域：`tests/` 两条判据 +（窄例外授权）`scripts/roco/evaluate-rule-promotion.mjs` L514/L550 + `reports/roco/product-execution/crosscut/`

---

## 0 · 结论一句话

两条判据的红**根因不同**：① 是判据把 Windows 绝对路径喂给 ESM `import()`；② 的**真正红因在产品侧**
（`evaluate-rule-promotion.mjs` 用 `startsWith('/')` 判绝对路径 ⇒ Windows 双根 `E:\a\E:\a\…`），
判据只是把它**遮住了**（import 阶段就 ENOENT，整个文件只算 1 条）。

## 1 · 改前 / 改后读数（Windows）

| 文件 | 改前 | 改后 |
|---|---|---|
| `tests/roco-panel-model-env-key.test.js` | exit 1 · tests 7 **pass 2 fail 5**；逐字 `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs` | exit 0 · **7 ✔ / 0 ✖** |
| `tests/roco-rule-promotion.test.js` | exit 1 · tests **1** pass 0 fail 1；逐字 `Error: ENOENT: no such file or directory, open 'E:\roco-coach\E:\roco-coach\data\roco\evidence\rule-evidence-ledger.json'` | 判据侧修后 tests 8 / pass 1 fail 7（红因仍在产品侧）→ **产品侧修后 exit 0 · 8 ✔ / 0 ✖** |

改前原始留档：`task47-before-panel.txt` · `task47-before-promotion.txt`；改后：`task47-after-panel.txt` · `task47-after-productfix-promotion.txt`

## 2 · 三处改动（都只改口径，判据语义/期望值一字未改）

1. `tests/roco-panel-model-env-key.test.js`：`import(${JSON.stringify(SERVER)})` → `import(${JSON.stringify(pathToFileURL(SERVER).href)})`（+ import `pathToFileURL`；注释留「旧写法 + 为什么改」）。
2. `tests/roco-rule-promotion.test.js`：`abs = (rel) => rel.startsWith('/') ? rel : join(ROOT, rel)` → `isAbsolute(rel) ? rel : join(ROOT, rel)`（+ import `isAbsolute`；注释留档）。
3. `scripts/roco/evaluate-rule-promotion.mjs` **L514 / L550**（窄例外授权）：
   `readFileSync(configPath.startsWith('/') ? configPath : join(root, configPath))` →
   `readFileSync(isAbsolute(configPath) ? configPath : join(root, configPath))`（与同文件 L243/L593/L827 的既有写法一致）。

## 3 · WSL 侧（`/root/.nvm/versions/node/v24.21.0/bin/node`）

| 文件 | 改后 |
|---|---|
| `roco-panel-model-env-key.test.js` | exit 0 · **7 ✔ / 0 ✖** |
| `roco-rule-promotion.test.js` | exit 0 · **8 ✔ / 0 ✖**（Linux 不退化） |

留档：`task47-after-productfix-wsl.txt`。

## 4 · 该脚本自己的 selftest

`node scripts/roco/evaluate-rule-promotion.mjs --selftest` ⇒ **exit 0、stdout 0 字节**（CLI 无输出，无法从 stdout 读数）。
真正带读数的是判据文件里的 `⑥ RC-102 自检：--selftest 的 12 条用例全部通过（≥6 条反证）`，它调用 `selftest({root: ROOT})`
（内部 L620-622/L746/L792 都传**绝对** `configPath`）⇒ **改后通过**（包含在 Windows 8/8 与 WSL 8/8 里）。
即：那几条原本会在 Windows 双根的地方，现在被同一处修复覆盖。

## 5 · 变异（长期没被发现的原因）

把 L514 改回 `startsWith('/')`（其余不动）：

| 平台 | 读数 |
|---|---|
| Windows | **exit 1 · tests 8 / pass 1 / fail 7**（`ENOENT … E:\roco-coach\E:\roco-coach\data\roco\rulesets\mobile-s4-candidate-v2.json`） |
| WSL | **exit 0 · tests 8 / pass 8 / fail 0** |

⇒ **Linux 绿、Windows 红**：这就是它长期潜伏的原因。留档 `task47-mutation-{windows,wsl}.txt`。
还原后 Windows **8/8 exit 0**，脚本内无遗留标记（grep 0）。

## 6 · 规则（本刀因果链写成规则）

> **判据在 Linux 绿、Windows 红，且红因是 `E:\a\E:\a\…` 双根 ⇒ 先查产品侧的绝对路径判断，而不是判据。**
> 先例：task-20/24/26（判据侧 `new URL().pathname`）、task-31（`import()` 吃绝对路径）、task-47（产品侧 `startsWith('/')`）。

## 7 · 顺手扫面（本刀只改上面三处）

`tests/**`：本家族只剩已修的留档注释（12 处 `.pathname` 命中均为 task-24/26 的「旧写法留档」）。
产品侧同族点**只读可达性判定**：

| 位置 | 形态 | 可达性判定（只读） | 处置 |
|---|---|---|---|
| `evidence-ledger-lib.mjs:92` `repoRelativeSource` | `startsWith('/')` 判绝对 | **不可达**：唯一调用方 L199 传的是台账 JSON 里的 `source.url`（仓内相对路径或 https，函数注释明写「仓库内文件」） | 不改 |
| `meta-prior-lib.mjs:301` `refResolvable` | 同上 | **不可达**：`ref` 来自配置 JSON（http(s) 或仓内相对路径） | 不改 |
| `verify-owned-pets.mjs:207` `isSafeArtifactPath` | `!path.startsWith('/')` 当「相对路径」判据 | **不可达**（当前无调用方传 Windows 绝对路径）；**形态是近亲不是双根**：它会把 `E:\…` **误判为相对**（校验宽松），且 `..` 检查按 `/` 切分 ⇒ `..\..` 也会漏过 | 不改，登记为潜在硬化项 |

（「不可达」= 只读判断：现有调用方不传 Windows 绝对路径；没有把它当活 bug 的理由，按纪律不动没坏的代码。）
