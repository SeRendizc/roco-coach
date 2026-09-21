// 模型臂成绩的**身份守卫**（W4-04 / W4-05）。
//
// 为什么需要这一组测试
// --------------------
// 第 37 轮查出：`reports/roco/shadow-replay-sft-v2.json` 里装的其实是 v1 的成绩、
// `-sft-v3.json` 里装的是 v2 的成绩、真正的 v3（文档写 205/288）**一个产物都没留下**。
// 报告里原来没有模型身份，运行器又把结果写到同一个文件名再由人工改名，
// 于是错位了也没有任何东西会红——文档和台账照着一组对不上号的数字继续往下走。
//
// 这一组测试把「文件名 ↔ 报告里记的适配器」这条对应关系钉住，并且**两个方向都测**：
// 正向（现有存档必须自洽）与反向（把身份改错必须被抓）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {identityMismatch, buildShadowReport} from '../../../scripts/roco/shadow-replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const REPORT_DIR = join(ROOT, 'reports', 'roco');

function loadArmReports() {
  return readdirSync(REPORT_DIR)
    .filter((name) => /^shadow-replay.*\.json$/.test(name))
    .map((name) => ({name, path: join(REPORT_DIR, name)}));
}

test('反向对照：身份对不上时必须被抓（这是这一组的意义所在）', () => {
  const v2 = {adapter: '/x/qwen35-4b-tool-v2', adapter_basename: 'qwen35-4b-tool-v2',
    adapter_sha256: 'deadbeef', prompt_digest: 'p'};
  const v1 = {...v2, adapter: '/x/qwen35-4b-tool-v1', adapter_basename: 'qwen35-4b-tool-v1'};
  // 名字与身份一致 → 不该报
  assert.equal(identityMismatch('shadow-replay-sft-v2.json', v2), null);
  // **真实事故的形状**：v2 的存档里装的是 v1 的身份 → 必须报
  const crossed = identityMismatch('shadow-replay-sft-v2.json', v1);
  assert.ok(crossed && crossed.includes('qwen35-4b-tool-v1'), `交叉存档没有被抓住：${crossed}`);
  // 基座报告不能是某个适配器的成绩
  assert.ok(identityMismatch('shadow-replay-base.json', v2));
  assert.equal(identityMismatch('shadow-replay-base.json', {adapter: null}), null);
  // 没有身份 → 必须报（「不知道是谁跑的」不能当「一样」）
  assert.ok(identityMismatch('shadow-replay-sft-v3.json', null));
  // 有身份但没有权重哈希 → 必须报（换版之后分辨不出来）
  assert.ok(identityMismatch('shadow-replay-sft-v1.json', {...v1, adapter_sha256: null}));
});

test('报告装配必须写进身份栏，而不是靠文件名猜', () => {
  const report = buildShadowReport({
    arm: 'local_4b', gateway: 'http://127.0.0.1:8766', rows: [],
    identity: {adapter: '/x/qwen35-4b-tool-v4', adapter_basename: 'qwen35-4b-tool-v4',
      adapter_sha256: 'abc', identity_digest: 'd'},
    outPath: 'reports/roco/shadow-replay-sft-v4.json',
  });
  assert.ok(report.identity, '报告没有 identity：存档错位又不会被发现了');
  assert.equal(report.identity.adapter_basename, 'qwen35-4b-tool-v4');
  assert.equal(report.written_to, 'reports/roco/shadow-replay-sft-v4.json');
});

test('每个已存档的模型臂报告，文件名与身份必须对得上', () => {
  const reports = loadArmReports()
    .filter((entry) => !existsSync(join(REPORT_DIR, 'invalidated', entry.name)));
  assert.ok(reports.length >= 1, '一个模型臂报告都没有：这一组测试等于没测');
  for (const {name, path} of reports) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // 规则臂不经过模型，没有适配器身份；它的存档只要求带上「规则臂」标记。
    const reason = identityMismatch(name, parsed.identity ?? null);
    assert.equal(reason, null, reason || '');
  }
});

test('已作废的错位存档必须留在 invalidated/ 并且写明原因', () => {
  const dir = join(REPORT_DIR, 'invalidated');
  const mine = existsSync(dir)
    ? readdirSync(dir).filter((entry) => /^shadow-replay.*\.json$/.test(entry))
    : [];
  if (!mine.length) return;   // 没有作废的模型臂存档时这一条不适用
  const readme = join(dir, 'README.md');
  assert.ok(existsSync(readme), 'invalidated/ 里必须有一份说明：这些产物为什么不可用');
  const text = readFileSync(readme, 'utf8');
  for (const name of mine) {
    assert.ok(text.includes(name), `说明里没有提到 ${name}`);
  }
});
