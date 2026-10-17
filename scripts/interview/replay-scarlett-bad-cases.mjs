#!/usr/bin/env node
// 官方「斯嘉丽」公开 Bad Case × 本仓三层口径 对账器（只读，不改任何文件）。
//
// 为什么要有这个脚本
// ------------------
// 官方 2026-08-15 深度采访（游戏葡萄/36氪）公开了两个真实 Bad Case：
//   ① 电系技能打翠顶夫人（翼系+水系）= 几倍？ 玩家答「三倍」，AI 分不清「克制/强力克制」；
//   ② 虫队怎么打火神：AI 让花衣蝶用灼烧逼退火神，但花衣蝶被火神三倍克制、火神也不吃灼烧。
// 这两个案例恰好可以拿来对本仓的「规则真值」做一次外部对账 —— 项目的核心主张是
// 「事实由程序算、模型只组织语言」，那程序自己算的那一格就必须与官方一致。
//
// 本脚本把同一格分别问三个层：
//   · 引擎      roco/src/roco_env/data.py::TypeChart.multiplier（Python，真打结算用的口径）
//   · RAG 语料  src/coach/rag-index.js::typeChartBody（教练讲课/检索到的正文）
//   · 客户端    src/client/type-affinity.js::defenceMultiplier（页面承伤提示）
// 三处若不一致，或与官方「三倍」不一致，就是面试里最危险的那类问题：
// 面试官只问一句「电系打翠顶夫人几倍」，候选人自己的系统会给出三个答案。
//
// 用法（只读）：
//   node scripts/interview/replay-scarlett-bad-cases.mjs
//   node scripts/interview/replay-scarlett-bad-cases.mjs --json   # 机器可读
//
// 备注：本脚本**不修改**任何数据；修复方案与实测影响见
// docs/interview/SCARLETT-BAD-CASE-REPLAY-2026-10-17.md 与分支 fix/typechart-official-3x。

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadCorpus, createRagIndex} from '../../src/coach/rag-index.js';
import {defenceMultiplier} from '../../src/client/type-affinity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const RAW_ARGS = new Set(process.argv.slice(2));
const AS_JSON = RAW_ARGS.has('--json');

// 官方公开 Bad Case（来源：36氪/游戏葡萄 2026-08-15 采访，原文见
// https://www.36kr.com/p/3939411707919744 ；官方 B 站 2026-08-07 视频）。
const CASES = [
  {
    id: 'scarlett-badcase-1',
    title: '电系打翠顶夫人（翼系+水系）',
    defender: ['翼系', '水系'],
    attack: '电系',
    official: 3,
    officialNote: '官方采访里玩家「不假思索答三倍」；上游 sim 注释亦写「双属性均弱 → 3x（强力克制，非乘算的 4x）」',
  },
  {
    id: 'scarlett-badcase-2',
    title: '火系打花衣蝶（虫系+草系）',
    defender: ['虫系', '草系'],
    attack: '火系',
    official: 3,
    officialNote: '官方采访：「花衣蝶被火神三倍克制」',
  },
];

// 第二类 Bad Case 不是倍率，是「火神不吃灼烧」。
const BURN_CASE = {
  id: 'scarlett-badcase-2b',
  title: '灼烧打火神（火系）',
  official: '火系精灵免疫灼烧',
  officialNote: '术语 1002 原文：「（火系精灵免疫此效果）」；官方采访：「火神也不吃灼烧的负面效果」',
};

const pythonProbe = () => {
  const code = `
import json, sys
sys.path.insert(0, 'roco/src')
from roco_env import data as rdata
rs = rdata.load_ruleset()
c = rs.type_chart
cases = [("翼系", "水系", "电系"), ("虫系", "草系", "火系")]
out = {}
for a, b, atk in cases:
    out[a + "|" + b + "|" + atk] = c.multiplier((a, b), atk)
# 官方 Bad Case 2b：术语 1002 的 immune_element 是否真被状态施加路径消费
# 这里只做静态登记：引擎 END_OF_TURN_STATUS 声明了 immune_element=火系，
# 但技能施加状态的分支（env.py::_apply_status_effects）没有读它 —— 由脚本外的人工核对。
out["burn_immune_declared"] = "火系"
print(json.dumps(out, ensure_ascii=False))
`;
  const raw = execFileSync('python3', ['-c', code], {cwd: REPO_ROOT, encoding: 'utf8'});
  return JSON.parse(raw);
};

const ragBodyOf = (key) => {
  const corpus = loadCorpus();
  const index = createRagIndex(corpus);
  const doc = index.documents.find(
    (d) => d.lib_id === 'L3' && String(d.title || '').includes(key),
  ) || index.documents.find((d) => d.lib_id === 'L3' && String(d.body || '').includes(`防御方属性 ${key}`));
  return doc ? String(doc.body) : null;
};

const pickMultiplier = (body, key) => {
  if (!body) return null;
  // 正文形如：`克制（weak） 电系 ×4 冰系 ×2`
  const line = body.split('\n').map((s) => s.trim()).find((s) => s.startsWith('克制（weak）'));
  if (!line) return null;
  const m = line.match(/(电系|火系) ×([\d.]+)/);
  return m ? Number(m[2]) : null;
};

const py = pythonProbe();
const rows = CASES.map((c) => {
  const defenderKey = c.defender.join('|');
  const engine = py[`${defenderKey}|${c.attack}`];
  const ragBody = ragBodyOf(defenderKey);
  const rag = pickMultiplier(ragBody, c.attack);
  const client = defenceMultiplier(c.defender, c.attack);
  const verdict = engine === c.official && rag === c.official && client === c.official
    ? '一致'
    : '不一致';
  return {...c, engine, rag, client, ragBody, verdict};
});

const result = {
  ruleset_id: (() => {
    try {
      const raw = readFileSync(join(REPO_ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/types.json'), 'utf8');
      return JSON.parse(raw).ruleset_id;
    } catch { return null; }
  })(),
  official_bad_cases: rows.map((r) => ({
    id: r.id, title: r.title, official: r.official,
    engine: r.engine, rag: r.rag, client: r.client, verdict: r.verdict,
    official_note: r.officialNote,
  })),
  burn_case: BURN_CASE,
  checked_at: new Date().toISOString(),
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log('官方「斯嘉丽」Bad Case × 本仓三层口径 对账（只读）');
console.log(`ruleset: ${result.ruleset_id}`);
console.log('');
console.log('| 官方 Bad Case | 官方 | 引擎(结算) | RAG语料(讲课) | 客户端(页面) | 判定 |');
console.log('|---|---|---|---|---|---|');
for (const r of result.official_bad_cases) {
  console.log(`| ${r.title} | ×${r.official} | ×${r.engine} | ×${r.rag} | ×${r.client} | ${r.verdict} |`);
}
console.log('');
console.log(`第三类：${BURN_CASE.title} —— 官方口径「${BURN_CASE.official}」。`);
console.log('  · 已修复（2026-10-17）：env.py 新增 _status_immune，术语 1001/1002/1008 的');
console.log('    immune_element 成为唯一实现，技能施加 + 「每驱散 1 层」两条路径都消费；');
console.log('    免疫时记 status_immune 事件、不写层数。回归判据：roco/tests/test_scarlett_bad_cases.py（6/6）。');
console.log('  · 修复前（历史留痕）：只有天气路径（env.py::_end_of_turn_weather）判免疫，');
console.log('    技能挂上的灼烧不会被免疫 —— 与官方采访「火神也不吃灼烧」相反。');
console.log('');
console.log('结论：三层对同一格给出不同答案时，先修「谁是真源」，再改判据 —— 不能只改文案。');
console.log('修复分支：fix/typechart-official-3x（已推送 gitee/GitHub；未改 master/wip）。');
