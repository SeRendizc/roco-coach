# 干净克隆验收（2026-10-17 · 从 gitee 公开分支 clone）

命令：`git clone --depth 1 --branch interview/2026-10-17 https://gitee.com/serendizc/roco-coach.git /tmp/roco-verify`

- 克隆 HEAD = `0c200fc71752989d56639a4bd65088e4e0f2d122`（= 本地分支 HEAD，逐位一致）
- 体积 739MB（含数据资产），工作树干净（无未跟踪文件）

## 在克隆体里直接跑（不依赖本机工作区）

| 检查 | 结果 |
|---|---|
| `node scripts/interview/replay-scarlett-bad-cases.mjs` | 电×翼\|水、火×虫\|草：引擎/RAG/客户端 **全部 ×3 一致**；免疫说明为修复后口径 |
| `node --test tests/roco-scarlett-tier-grounding.test.js` | **7/7** |
| `node --test tests/roco-rag-typechart.test.js` | **11/11** |
| `npm run test:roco-quality` | **77/77** |
| `cd roco && PYTHONPATH=src python3 -m unittest tests.test_scarlett_bad_cases tests.test_type_multiplier_ruling` | **Ran 14 tests … OK**（6 Bad Case + 8 相性裁决） |

## 安全/边界核对

- `docs/interview/cv/` 在克隆中**不存在**（CV 含个人联系方式，已 gitignore，未进公开分支）。
- 扫描克隆体未见 API key/令牌模式（推送前已做过一次扫描；克隆体复核一致）。
- 证据链自包含：台账、复现器、判据、PM 说明都在仓库里，**别人 clone 下来即可复查**。

## 结论

「可核查」验收通过：公开分支上的证据不是只在本机成立，而是**干净克隆即可复现**。
