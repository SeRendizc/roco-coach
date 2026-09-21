# 训练环境声明（Windows / RTX 3060）

> 起因：Windows 侧 `B-20260921-05`（owner: mac）指出产品仓只声明了一份 **agent 运行时** 锁
> （`requirements-agent.lock.txt`），而**训练侧依赖集没有任何版本声明**；`CONTRACTS.md` 又把
> 「LightGBM baseline」写成 `TeamDatasetV2` 的消费者。本文是 Mac 对这件事的决定。

## 1. 决定（D-20260921-04）

1. **训练环境必须在产品仓里有版本记录**：新增 `requirements-train.lock.txt`，**由 Windows 生成**
   （在已验证的 venv 里 `pip freeze` 或等价的 lock 生成方式），与 `requirements-agent.lock.txt`
   **并列而不合并**：两份锁服务两件事（agent 运行时 vs CUDA 训练），合并会让「谁动了什么」不可查。
2. **`requirements-agent.lock.txt` 不许改**。训练依赖只进 `requirements-train.lock.txt`。
3. 每次变更（新增/升级任何包）必须在协作区 `WIN_STATUS.md` 里带上：变更原因、`pip freeze` 的 sha256、
   解析后的版本（`torch` 必须与已验证的 `2.8.0+cu128` 一致或明确说明为什么变）。
4. **首个消费者是 LightGBM 的 pairwise 队伍排序基线**（RC-602 / `TeamDatasetV2` 的 consumers 里写的就是它）。
   小型神经排序器（DeepSets / Set Transformer）**排在第二位**，只在数据集契约 `ready` 之后再引入 ——
   现在产品仓里 LightGBM / xgboost / torch-geometric / deepset **都没有**声明，先装哪个是本决定要回答的问题。
5. 训练依赖**不进协作区**：协作区只登记名称、producer commit、版本、字节数、SHA-256 与生成命令
   （README「大文件」一节）。venv 本身（6.8 GB）永不进 Git。

## 2. 为什么先 LightGBM 而不是先神经排序器

- 它给的是**可解释的基线**：特征重要性可以直接对着我们的 gap 诊断与 `TeamFeatureV2` 逐项核对；
  神经排序器在数据集切分与泄漏检查还没立起来之前，指标无法归因（是模型强还是数据泄漏）。
- `CONTRACTS.md` 已经把 `TeamDatasetV2` 的 consumers 写成「LightGBM baseline, DeepSets Team Ranker」——
  顺序本来就是先基线后集合模型。
- CPU 可训、迭代快，不会把 3060 的显存与时间先花在超参上。

## 3. 当前状态（如实）

- **正式训练仍然被 `CONTRACTS.md` 的闸门挡住**：`BattleModeV2` `draft`、`TeamFeatureV2` `missing`、
  `TeamDatasetV2` `invalidated`、`CompletionDatasetV1` `missing` → 闸门 **blocked**。
  本文只决定「环境怎么声明」，**不解除训练闸门**。
- Windows 已经完成 CUDA 验收（20/20，`sm_86`，`torch==2.8.0+cu128`，未训练任何东西），
  这是环境侧的事实，不是数据契约就绪的证据。

## 4. 交接清单（Windows 生成锁时照这个做）

1. 在已验证的 venv 里生成 `requirements-train.lock.txt`（含 GPU 栈与 LightGBM）；
2. 记 `sha256`，写进 `WIN_STATUS.md` 与协作区（**不要**把文件内容贴进协作区）；
3. 跑一条最小可复现命令证明它能装（例如在新 venv 里 `pip install -r requirements-train.lock.txt`
   后 `python -c "import lightgbm, torch; ..."`），把命令与输出摘要记进 `WIN_STATUS.md`；
4. 在 `WIN_STATUS.md` 的 `Needs from Mac` 里删掉这一条不需要 —— 它已在 `D-20260921-04` 里答复，
   阻塞状态由 Windows 侧在 `BLOCKERS.md` 里标 `resolved`（Mac 不代改对方的条目）。
