// 「同一个角色在工坊与产品页显示不同中文」的**可复跑判据**（2026-09-25 新增）。
//
// 起因（漂移现场）：`src/client/team-workshop.js` 的 `fillSelect()` 里曾经**又声明了一份**
// `ROLE_CN`，把 `recovery` 写成「恢复」；而同一个仓库里另外三处都写「回复」：
//   · `src/client/team-workshop.js` 文件顶部（工坊自己的唯一真值源，下拉框 `#tw-filter-role` 读它）
//   · `src/client/roco.js:271` 的 `ROLE_LABEL`（产品页定位筛选与精灵卡读它）
//   · `src/server/roco-service.js:300` 的 `BOX_ROLE_LABELS`（`/api/roco/box` 的 `filters_available.roles`）
// 于是**同一个下拉框里**会同时出现「回复」与「恢复」两种译法。
//
// 这一份钉三件事，每条都有**必红方向**（构造违规样本，看同一条判据会不会翻红）：
//   ① 三处词表逐键相等（键集合 + 中文 + 顺序）；`recovery` 必须逐字是「回复」；
//   ② 工坊文件里 `ROLE_CN` **只能声明一次**，且文件里不再出现「恢复」这个漂移字面量；
//   ③ 工坊下拉框的选项词表（`ROLE_CYCLE`）必须被 `ROLE_CN` 全覆盖——否则玩家会看到英文枚举名。
//
// 判据本体是下面导出的纯函数 `roleLabelProblems(...)`：单测与（若将来接入）浏览器验收共用同一份。
//
// 用法：`node --test tests/roco-role-label-consistency.test.js`
//
// ⚠ 注册提醒：`package.json` 的 `test:unit` 是**别人负责**的清单（本次施工不许改），
//   所以这一条现在要显式跑（或者由主线程把它加进 `test:unit`）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ROLE_CN} from '../src/client/team-workshop.js';
import {BOX_ROLE_LABELS} from '../src/server/roco-service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
/** 报告里贴**实际输出原文**，不只是「断言失败」。 */
const show = (value, limit = 320) => JSON.stringify(value).slice(0, limit);

/**
 * 从 `src/client/roco.js` 源码里抠出 `ROLE_LABEL` 与 `ROLE_ORDER`。
 *
 * 为什么抠源码而不是 import：`roco.js` 是**浏览器经典脚本**（顶部就摸 `document`，
 * 通过 `window.rocoDemo` 对外），在 Node 里 import 会当场抛。抠源码是这里唯一可行的读法；
 * 抠不到就**判红**（不是跳过）——那样以后有人改名，这条判据会立刻响。
 */
export function roleTablesFromRoco(source) {
  const label = source.match(/const ROLE_LABEL\s*=\s*\{([^}]*)\}/);
  const order = source.match(/const ROLE_ORDER\s*=\s*\[([^\]]*)\]/);
  const parsePairs = (text) => Object.fromEntries(
    text.split(',').map((part) => part.split(':').map((piece) => piece.trim().replace(/^['"]|['"]$/g, '')))
      .filter((pair) => pair.length === 2 && pair[0]));
  return {
    label: label ? parsePairs(label[1]) : null,
    order: order ? order[1].split(',').map((piece) => piece.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null,
  };
}

/**
 * 判据本体（纯函数，可喂违规样本做反证）。
 *
 * @param {{roleCn:object, pageLabel:object|null, pageOrder:string[]|null, boxLabels:object}} tables
 * @returns {string[]} 问题清单；空数组 = 通过
 */
export function roleLabelProblems({roleCn, pageLabel, pageOrder, boxLabels}) {
  const problems = [];
  if (!roleCn || !pageLabel || !boxLabels) {
    problems.push(`词表缺失：workshop=${Boolean(roleCn)} page=${Boolean(pageLabel)} box=${Boolean(boxLabels)}`);
    return problems;
  }
  const keys = Object.keys(roleCn).sort();
  for (const [name, table] of [['产品页 ROLE_LABEL', pageLabel], ['服务端 BOX_ROLE_LABELS', boxLabels]]) {
    const other = Object.keys(table).sort();
    if (JSON.stringify(other) !== JSON.stringify(keys)) {
      problems.push(`${name} 的键集合与工坊不一致：${JSON.stringify(other)} ≠ ${JSON.stringify(keys)}`);
    }
    for (const key of keys) {
      if (table[key] !== roleCn[key]) {
        problems.push(`同一个定位 ${key} 译法不同：工坊「${roleCn[key]}」 vs ${name}「${table[key]}」`);
      }
    }
  }
  if (roleCn.recovery !== '回复') {
    problems.push(`recovery 必须是「回复」（历史漂移是把函数内那份写成「恢复」），实际「${roleCn.recovery}」`);
  }
  if (pageOrder && JSON.stringify(pageOrder) !== JSON.stringify(Object.keys(roleCn))) {
    problems.push(`产品页 ROLE_ORDER 的顺序与工坊词表键顺序不一致：${JSON.stringify(pageOrder)} `
      + `≠ ${JSON.stringify(Object.keys(roleCn))}`);
  }
  return problems;
}

/** ② 源码级：`ROLE_CN` 只能声明一次，且漂移字面量「恢复」不许再出现。 */
export function roleSourceProblems(source) {
  const problems = [];
  const declarations = source.match(/(?:const|let|var)\s+ROLE_CN\s*=/g) ?? [];
  // 导出那一行也是 `export const ROLE_CN =`，仍算那一处声明
  if (declarations.length !== 1) {
    problems.push(`team-workshop.js 里 ROLE_CN 必须**只声明一次**（真值源），实际 ${declarations.length} 处`);
  }
  if (/recovery:\s*['"]恢复['"]/.test(source)) {
    problems.push('team-workshop.js 里仍有 recovery:「恢复」这一漂移写法');
  }
  return problems;
}

/** ③ 下拉框选项词表必须被中文词表全覆盖（否则玩家看到的是 `recovery` 这种枚举名）。 */
export function roleOptionProblems(roleCycle, roleCn) {
  const problems = [];
  for (const value of roleCycle) {
    if (value === '') continue;
    if (!roleCn[value]) problems.push(`下拉框选项 ${value} 不在 ROLE_CN 里 → 玩家会看到英文枚举名`);
  }
  const cycle = roleCycle.filter(Boolean);
  const keys = Object.keys(roleCn).filter((key) => !cycle.includes(key));
  if (keys.length) problems.push(`ROLE_CN 里的 ${JSON.stringify(keys)} 在下拉框选项里没有落点`);
  return problems;
}

const WORKSHOP_SRC = read('src/client/team-workshop.js');
const ROCO_SRC = read('src/client/roco.js');
const tables = roleTablesFromRoco(ROCO_SRC);
const roleCycle = (WORKSHOP_SRC.match(/const ROLE_CYCLE\s*=\s*\[([^\]]*)\]/)?.[1] ?? '')
  .split(',').map((piece) => piece.trim().replace(/^['"]|['"]$/g, ''));

test('① 三处定位词表逐键相等（工坊 / 产品页 / 服务端）', () => {
  const problems = roleLabelProblems({
    roleCn: ROLE_CN, pageLabel: tables.label, pageOrder: tables.order, boxLabels: BOX_ROLE_LABELS,
  });
  console.log('  · [实际输出] 工坊 ROLE_CN =', show(ROLE_CN));
  console.log('  · [实际输出] 产品页 ROLE_LABEL =', show(tables.label));
  console.log('  · [实际输出] 服务端 BOX_ROLE_LABELS =', show(BOX_ROLE_LABELS));
  console.log('  · [实际输出] 产品页 ROLE_ORDER =', show(tables.order));
  assert.deepEqual(problems, []);
  assert.equal(ROLE_CN.recovery, '回复');
});

test('① 必红方向：把工坊那份的 recovery 改回「恢复」必须被抓住', () => {
  const drifted = {...ROLE_CN, recovery: '恢复'};
  const problems = roleLabelProblems({
    roleCn: drifted, pageLabel: tables.label, pageOrder: tables.order, boxLabels: BOX_ROLE_LABELS,
  });
  console.log('  · [实际输出] 违规样本 →', show(problems));
  assert.ok(problems.some((p) => p.includes('recovery') && p.includes('恢复')),
    `漂移样本必须报错，实际：${show(problems)}`);
  assert.ok(problems.some((p) => p.includes('译法不同')), `必须点名「同一个定位译法不同」，实际：${show(problems)}`);
});

test('① 必红方向：漏掉一个键 / 顺序变了也必须被抓住', () => {
  const missing = {...ROLE_CN};
  delete missing.control;
  const p1 = roleLabelProblems({roleCn: missing, pageLabel: tables.label, pageOrder: tables.order, boxLabels: BOX_ROLE_LABELS});
  const p2 = roleLabelProblems({
    roleCn: ROLE_CN, pageLabel: tables.label,
    pageOrder: [...tables.order].reverse(), boxLabels: BOX_ROLE_LABELS,
  });
  console.log('  · [实际输出] 缺键样本 →', show(p1));
  console.log('  · [实际输出] 顺序样本 →', show(p2));
  assert.ok(p1.some((p) => p.includes('键集合')), `缺键必须报错，实际：${show(p1)}`);
  assert.ok(p2.some((p) => p.includes('顺序')), `顺序不一致必须报错，实际：${show(p2)}`);
});

test('② 工坊文件里 ROLE_CN 只声明一次，且没有「恢复」漂移字面量', () => {
  const problems = roleSourceProblems(WORKSHOP_SRC);
  const declarations = WORKSHOP_SRC.match(/(?:const|let|var)\s+ROLE_CN\s*=/g) ?? [];
  console.log('  · [实际输出] team-workshop.js 里 ROLE_CN 声明处数 =', declarations.length);
  console.log('  · [实际输出] 含 recovery:「恢复」 =', /recovery:\s*['"]恢复['"]/.test(WORKSHOP_SRC));
  assert.deepEqual(problems, []);
});

test('② 必红方向：函数内再声明一份（原漂移的写法）必须被抓住', () => {
  const drifted = `${WORKSHOP_SRC}\n  const ROLE_CN = {attacker: '输出', recovery: '恢复'};\n`;
  const problems = roleSourceProblems(drifted);
  console.log('  · [实际输出] 二次声明样本 →', show(problems));
  assert.ok(problems.some((p) => p.includes('只声明一次')), `二次声明必须报错，实际：${show(problems)}`);
});

test('③ 下拉框选项词表被 ROLE_CN 全覆盖', () => {
  const problems = roleOptionProblems(roleCycle, ROLE_CN);
  console.log('  · [实际输出] ROLE_CYCLE =', show(roleCycle));
  assert.deepEqual(problems, []);
  assert.equal(roleCycle.length, Object.keys(ROLE_CN).length + 1, '下拉框 = 一个「全部」+ 五个定位');
});

test('③ 必红方向：下拉框里多一个词表没有的取值必须被抓住', () => {
  const problems = roleOptionProblems([...roleCycle, 'speedster'], ROLE_CN);
  console.log('  · [实际输出] 多选项样本 →', show(problems));
  assert.ok(problems.some((p) => p.includes('speedster')), `多出来的选项必须报错，实际：${show(problems)}`);
});
