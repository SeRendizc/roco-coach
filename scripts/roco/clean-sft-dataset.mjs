#!/usr/bin/env node
/**
 * 清理 SFT 数据集里**随工具退役而失效**的目标，并把输入的 `tools` 列表对齐到**共享契约**。
 *
 * 由来（Codex 的 4B 训练前置交接第 1、2 项，逐字）：
 *  1. 「把 runtime 实际工具集合、系统提示词、输入序列化与训练/评估**统一为共享实现**。」
 *  2. 「清理 sft-v8 中 `inspect_training` 的 128/8/8 条失效目标；**不要直接将全部旧培养问题改成 stop**。
 *      按当前能力重新标注真实下一步。」
 *  Codex 在即时监工里又补了一句：「**只把 12 工具列出来不等于参数契约/序列化/训练一致**。」
 *
 * ## 实测到的两处失效（不是猜的）
 *
 * | | 量 | 事实 |
 * |---|---|---|
 * | 输入侧 | **1008 行**的 `tools` 列表里有 **13** 项 | = 12 个现行工具 **+ 已退役的 `inspect_training`** |
 * | 目标侧 | **144 行**（train 128 / valid 8 / test 8）的目标就是 `{"tool":"inspect_training"}` | 一个**不存在**的工具 |
 *
 * 退役出处：`src/coach/toolbox.js:149` —— 2026-09-27 人类「附 1. 删」+「加点不要了」。
 *
 * ## 为什么这三族的问题是 `stop` 而不是 `query_rules`（**逐族核过，不是一刀切**）
 *
 * 全数据集里提到培养字样的只有 **3 个不重复问句**（136 行）：
 *   1.「它还有几个培养格能用？」——已退役功能的**个体状态**
 *   2.「我还有多少训练点？」——已退役功能的**玩家资源**
 *   3.「**培养格是怎么分配的？**」——**看起来是规则问题**，所以我去核了规则源：
 *       `grep -rn "培养格\|训练点" data/roco/ roco/` ⇒ **0 命中**（规则集、知识卡、百科语料都没有）
 *       ⇒ 标成 `query_rules` 会把模型送去一个**答不出来**的工具，比诚实的 stop 更糟。
 *   ⇒ 三族都标 `{"stop":true}`，**但每条都带下面 `FAMILIES` 里的依据**，可审计。
 *
 * ## 安全边界（这个脚本**不许**静默猜）
 *
 * 遇到 `FAMILIES` 里**没有登记**的未知工具目标 ⇒ **不猜、不改**，记进 `refused` 并以退出码 2 结束。
 * 「把所有不认识的目标都改成 stop」正是 Codex 警告的那种机械处理。
 *
 * 用法：
 *   node scripts/roco/clean-sft-dataset.mjs                 # 只报告差异（不写盘）
 *   node scripts/roco/clean-sft-dataset.mjs --write         # 写到 reports/roco/sft-v8-clean/
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCAL_PLAN_TOOLS, TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const IN_DIR = join(ROOT, 'reports', 'roco', 'sft-v8');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'sft-v8-clean');
const SPLITS = ['train', 'valid', 'test'];

/**
 * **已核过的失效目标族**：只认这两个问句，且只标 `{"stop":true}`。
 * 任何不在这张表里的失效目标 ⇒ 拒绝处理（`refused`），不猜。
 */
const FAMILIES = Object.freeze([
  Object.freeze({
    id: 'retired-training-slots',
    question: '它还有几个培养格能用？',
    retarget: {stop: true},
    why: '「培养格」是 2026-09-27 人类裁决退役的功能（toolbox.js:149「加点不要了」）；'
      + '`grep -rn "培养格\|训练点" data/roco/ roco/` ⇒ 0 命中 ⇒ 没有任何工具或数据源能答。',
  }),
  Object.freeze({
    id: 'retired-training-points',
    question: '我还有多少训练点？',
    retarget: {stop: true},
    why: '同上：训练点随加点一起退役，规则集与语料里都没有这条，任何工具都答不出来。',
  }),
  Object.freeze({
    id: 'level-already-in-focus-detail',
    question: '它满级了吗？',
    retarget: {stop: true},
    // ⚠ 这一族**不是**"功能退役"，理由与前三族**不同** —— 拒绝路径把它逼出来之后单独核的。
    why: '等级**已经在焦点资料里**：`src/coach/runtime.js:361` 的 `wantsLevel` 路径直接读 '
      + '`detail.level`（`:300` 也会把它写进「（Lv.N）」），而 `MAX_LEVEL` 是从 '
      + '`src/game/progression.js` 导入的 ⇒ **答得出来，不需要再调工具**。'
      + '标成 `read_state` 是错的：那读的是**对局状态**，而这个问题问的是**盒子里这一只**的等级。',
  }),
  Object.freeze({
    id: 'retired-training-allocation-rule',
    question: '培养格是怎么分配的？',
    retarget: {stop: true},
    // ⚠ 这条**看起来**像规则问题，所以单独给了依据 —— 这正是「不许一刀切」的地方。
    why: '它**看起来**该走 `query_rules`，但去核了规则源：规则集 / 知识卡 / 百科语料里'
      + '「培养格」「训练点」**0 命中** ⇒ 标成 `query_rules` 等于把模型送去一个答不出来的工具，'
      + '比诚实的 stop 更糟。**核过之后**才归到这一族。',
  }),
]);

const familyOf = (message) => FAMILIES.find((f) => String(message ?? '').trim() === f.question) ?? null;

function readRows(split) {
  const path = join(IN_DIR, `${split}.jsonl`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${split}:${i + 1} 不是合法 JSON`);
    }
  });
}

function main() {
  const write = process.argv.includes('--write');
  const contract = Object.keys(TOOL_CONTRACTS);
  const allowed = new Set(contract);
  const report = {
    artifact: 'sft-dataset-clean',
    why: '把输入的 tools 列表对齐到共享契约 TOOL_CONTRACTS，并清掉随工具退役而失效的目标（Codex 4B 前置第 1/2 项）',
    input_dir: 'reports/roco/sft-v8',
    contract_tools: contract,
    local_plan_tools: [...LOCAL_PLAN_TOOLS],
    contract_matches_local_plan: contract.length === LOCAL_PLAN_TOOLS.length
      && contract.every((name, i) => name === LOCAL_PLAN_TOOLS[i]),
    families: FAMILIES.map((f) => ({id: f.id, question: f.question, retarget: f.retarget, why: f.why})),
    splits: {},
    refused: [],
  };

  const out = {};
  for (const split of SPLITS) {
    const rows = readRows(split);
    if (!rows) { report.splits[split] = {missing: true}; continue; }
    let toolsRewritten = 0; let toolsEntriesDropped = 0; let retargeted = 0;
    const byFamily = {};
    for (const row of rows) {
      const user = (row.messages ?? []).find((m) => m.role === 'user');
      const assistant = (row.messages ?? []).find((m) => m.role === 'assistant');
      if (!user || !assistant) continue;
      let input = null;
      try { input = JSON.parse(user.content); } catch { continue; }

      // ① 输入侧：tools 列表对齐到**共享契约**（唯一真值来源，不手抄）
      if (Array.isArray(input.tools)) {
        const before = input.tools;
        const dropped = before.filter((name) => !allowed.has(name));
        if (before.length !== contract.length || dropped.length) {
          input.tools = [...contract];
          toolsRewritten += 1;
          toolsEntriesDropped += dropped.length;
        }
      }
      user.content = JSON.stringify(input);

      // ② 目标侧：只改**已登记**的失效族；遇到没登记的就拒绝，不猜
      let target = null;
      try { target = JSON.parse(assistant.content); } catch { continue; }
      if (target && typeof target.tool === 'string' && !allowed.has(target.tool)) {
        const family = familyOf(input.message);
        if (!family) {
          report.refused.push({split, tool: target.tool, message: String(input.message ?? '').slice(0, 60)});
          continue;
        }
        assistant.content = JSON.stringify(family.retarget);
        retargeted += 1;
        byFamily[family.id] = (byFamily[family.id] ?? 0) + 1;
      }
    }
    out[split] = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
    report.splits[split] = {rows: rows.length, tools_rewritten: toolsRewritten, tools_entries_dropped: toolsEntriesDropped, retargeted, by_family: byFamily};
  }

  report.refused_total = report.refused.length;
  if (write && report.refused_total === 0) {
    mkdirSync(OUT_DIR, {recursive: true});
    for (const split of SPLITS) if (out[split]) writeFileSync(join(OUT_DIR, `${split}.jsonl`), out[split]);
    writeFileSync(join(OUT_DIR, 'REPORT.json'), `${JSON.stringify(report, null, 1)}\n`);
  }

  console.log(`[clean-sft] 契约工具 ${contract.length} 个；LOCAL_PLAN_TOOLS 与契约一致：${report.contract_matches_local_plan}`);
  for (const split of SPLITS) {
    const s = report.splits[split];
    if (!s || s.missing) { console.log(`  ${split}: （没有这个文件）`); continue; }
    console.log(`  ${split}: ${s.rows} 行｜tools 列表改写 ${s.tools_rewritten} 行（丢掉退役项 ${s.tools_entries_dropped} 处）｜目标重标 ${s.retargeted} 行｜${JSON.stringify(s.by_family)}`);
  }
  if (report.refused_total) {
    console.log(`[clean-sft] ✖ 拒绝处理 ${report.refused_total} 条**没登记**的失效目标（不猜、不改）：`);
    for (const r of report.refused.slice(0, 8)) console.log(`  - ${r.split}｜tool=${r.tool}｜${r.message}`);
    console.log('  ↳ 这些要**先人工核**：它是不是又一个退役工具？还是该改标成某个现行工具？核完登记进 FAMILIES 再跑。');
    process.exit(2);
  }
  if (write) console.log(`[clean-sft] 已写 → reports/roco/sft-v8-clean/（**v8 原文件保留未动**）`);
  else console.log('[clean-sft] 只报告（加 --write 才落盘）');
}

main();
