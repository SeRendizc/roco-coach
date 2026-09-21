// 状态文档一致性检查**自己**的守卫。
//
// 它必须真的能发现不一致，否则就是又一层「看起来在检查」的壳。
// 这里用构造文本做反证：声明的 HEAD 不存在、引用不存在的产物路径，都必须被抓到。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join as pathJoin} from 'node:path';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const {hashesIn, declaredHead, check} = await import('../../scripts/roco/verify-state-doc.mjs');

test('只把像哈希的片段当哈希：纯数字与短标识不算', () => {
  const text = '`bbd5563` `c39811d` `20260921` `round8` `v1` `0.6` `abcdefg`';
  const found = hashesIn(text);
  assert.ok(found.includes('bbd5563'));
  assert.ok(found.includes('c39811d'));
  assert.ok(!found.includes('20260921'), '纯数字（日期/种子）不该被当哈希');
  assert.ok(!found.includes('round8'), '含非十六进制字符的标识不该被当哈希');
});

test('声明的 HEAD 从那一行读出来，读不到就返回 null', () => {
  assert.equal(declaredHead('| HEAD | `bbd5563`（说明）—— 已推送 |'), 'bbd5563');
  assert.equal(declaredHead('没有这一行'), null);
  assert.equal(declaredHead('| HEAD | 没有反引号 |'), null);
});

test('反证：声明一个不在历史里的 HEAD 必须被判不一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-doc-'));
  try {
    const doc = join(dir, 'STATE.md');
    writeFileSync(doc, '| HEAD | `deadbee` |\n\n引用产物：`reports/roco/verification/latest.json`\n');
    const report = check({doc, root: ROOT});
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.includes('不是当前 HEAD') || p.includes('祖先')),
      `应当报「HEAD 不在历史里」，实际：${JSON.stringify(report.problems)}`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('反证：引用不存在的产物路径必须被判不一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-doc-'));
  try {
    const doc = join(dir, 'STATE.md');
    // 路径必须用 ASCII：文档里引用的路径**本来就该是 ASCII**
    // （文件名是英文的，中文只出现在说明里）。用中文名会正好落在这个检查
    // 所用的路径正则之外，于是「反证」变成在测正则而不是在测判据。
    writeFileSync(doc, '| HEAD | `bbd5563` |\n\n引用：`reports/roco/absent-artifact-xyz.md`\n');
    const report = check({doc, root: ROOT});
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.includes('不存在的产物路径')),
      `应当报「引用了不存在的产物」，实际：${JSON.stringify(report.problems)}`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('当前仓库的状态文档必须一致', () => {
  const report = check();
  assert.equal(report.ok, true, `状态文档与现实不一致：\n${report.problems.join('\n')}`);
  assert.ok(report.suites >= 8, `最近验证的套件数太少（${report.suites}）`);
});

test('自指死锁的回归：最近一次 verify:release 是红的，**不该**让闸门永远卡死', () => {
  // 第 38 轮实测撞上的死锁：`verify:release` 的清单里有 `unit`，
  // 而 `unit` 里有一条断言「最近一次 verify:release 必须是 pass」——一次失败之后
  // 每次跑都会因为上一次红而红，而 latest.json 只能靠一次成功的运行变绿。
  // 唯一的出路是手改 latest.json，那正是最不该被鼓励的动作。
  //
  // 现在的口径：`last-green.json`（只有全绿才写）是硬要求；`latest.json` 红了只报警告。
  // 这里直接对着**真实的**仓库状态断言：即使 latest.json 是红的，
  // 只要存在一次全绿记录，检查也必须通过。
  const latestPath = pathJoin(ROOT, 'reports', 'roco', 'verification', 'latest.json');
  const greenPath = pathJoin(ROOT, 'reports', 'roco', 'verification', 'last-green.json');
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  if (!readFileSync) return;
  const report = check({root: ROOT});
  // 不论 latest.json 是什么结论，`warnings` 都要如实说出来（不许悄悄放过）
  if (latest.verdict !== 'pass') {
    assert.ok(report.warnings.some((w) => w.includes('最近一次 verify:release')),
      '最近一次是红的，但报告里连一句警告都没有');
  }
  // 而硬判据只看 last-green：它不存在时只警告，存在时不许因为 latest 红而失败
  const greenExists = (() => { try { readFileSync(greenPath, 'utf8'); return true; } catch { return false; } })();
  if (greenExists) {
    assert.equal(report.problems.filter((p) => p.includes('latest.json')).length, 0,
      'latest.json 红了被算成了硬失败——死锁又回来了');
  }
});
