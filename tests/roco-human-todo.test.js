/**
 * 判据：**人类待办清单**里的数字必须与真源一致（2026-09-27）。
 *
 * 为什么要有这一条：`docs/roco/HUMAN-REVIEW-CHECKLIST.md` 是给人类看的"只有你能做的事"清单，
 * 里面几个数字（金标已审几条、留出集几条、多少个体是掷点）**会变** ——
 * 文档里的数字一旦烂掉，人类按它做判断就会出错，而没人会注意到。
 * 所以数字写在文档的一个注释标记里（`<!-- TODO-NUMBERS … -->`），这里逐个数与真源比对。
 *
 * 真源：
 *   · 金标：`data/roco/gold/review-state.json`（`cases` 的条数与 `status==='approved'` 的条数）
 *   · 留出集：`tests/evals/agent-tasks-v2-tool-coverage.jsonl` 的**用例行数**（跳过 manifest 行）
 *   · 掷点：`data/roco/owned/owned-pets.json` 经 `individualsFromDataset()` 之后
 *     `*_source` 里含 `rolled` 的个体数（与"有多少个体"）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {individualsFromDataset} from '../src/coach/individuals.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = 'docs/roco/HUMAN-REVIEW-CHECKLIST.md';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 文档里那行机器可读的标记 → `{gold_approved: '0', …}`。 */
export function todoNumbers(text) {
  const marker = String(text).match(/<!--\s*TODO-NUMBERS([^>]*)-->/);
  if (!marker) return null;
  const out = {};
  for (const pair of marker[1].trim().split(/\s+/)) {
    const [key, value] = pair.split('=');
    if (key) out[key] = value;
  }
  return out;
}

test('① 清单里的数字与真源逐个数一致（数字烂了 = 判据红）', () => {
  const numbers = todoNumbers(read(DOC));
  assert.ok(numbers, `文档里要有 <!-- TODO-NUMBERS … --> 标记：${DOC}`);

  // 金标：真源是 review-state.json
  const gold = JSON.parse(read('data/roco/gold/review-state.json'));
  const cases = Object.values(gold.cases ?? {});
  const approved = cases.filter((row) => row.status === 'approved').length;
  assert.equal(String(approved), numbers.gold_approved,
    `金标已审条数变了（真源 ${approved}）⇒ 改 ${DOC} 的标记`);
  assert.equal(String(cases.length), numbers.gold_total,
    `金标总数变了（真源 ${cases.length}）⇒ 改 ${DOC} 的标记`);

  // 留出集：真源是那份 jsonl（跳过 manifest / 非用例行）
  const slice = read('tests/evals/agent-tasks-v2-tool-coverage.jsonl').split('\n')
    .map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.record_type === 'agent_tool_coverage_case');
  assert.equal(String(slice.length), numbers.phase_e_cases,
    `工具覆盖切片的用例数变了（真源 ${slice.length}）⇒ 改 ${DOC} 的标记`);

  // 掷点：真源是数据集 + individualsFromDataset()
  const dataset = JSON.parse(read('data/roco/owned/owned-pets.json'));
  const list = individualsFromDataset(dataset);
  const rolled = list.filter((one) => [one.nature_source, one.talent_source]
    .some((source) => typeof source === 'string' && source.includes('rolled'))).length;
  assert.equal(String(rolled), numbers.rolled_individuals,
    `掷点个体数变了（真源 ${rolled}）⇒ 改 ${DOC} 的标记`);
  assert.equal(String(list.length), numbers.owned_individuals,
    `个体总数变了（真源 ${list.length}）⇒ 改 ${DOC} 的标记`);
});

test('② 清单必须覆盖那五件事，且每件都有「文件 / 你要做什么 / 达标标准」三件套', () => {
  const doc = read(DOC);
  const topics = ['金标 59 条送审', 'Phase E', '真实**性格** / **天分**', '成长口径冲突', '隐藏个体值'];
  for (const topic of topics) {
    assert.ok(doc.includes(topic), `清单里缺这一件：${topic}`);
  }
  // 每一节都要有三件套（标题或正文里出现这三样）
  // ⚠ 只查**五件正事**那几节；文末的「附：另外两件」是补充，不要求同一套三件套
  // （2026-09-27：第一版把附节也查了，于是判据红在一个不该红的地方）。
  const sections = doc.split(/\n## /).slice(1).filter((section) => !/^附[:：]/.test(section.trim()));
  assert.ok(sections.length >= 5, `至少要五节正事（实际 ${sections.length}）`);
  for (const section of sections) {
    const title = section.split('\n')[0].trim();
    for (const word of ['你要做什么', '达标标准', '文件']) {
      assert.ok(section.includes(word), `「${title}」这一节缺「${word}」`);
    }
  }
  // 每一条都要指到真实存在的文件（链接不许指空）
  // 链接按文档所在目录（`docs/roco/`）解析：`../../x` → 仓库根，`../x` → `docs/x`，裸名 → 同目录
  for (const [, path] of doc.matchAll(/\]\(([^)]+\.(?:md|json|jsonl|js|mjs))\)/g)) {
    const target = path.startsWith('../../') ? path.slice(6)
      : path.startsWith('../') ? `docs/${path.slice(3)}`
        : `docs/roco/${path}`;
    assert.ok(readOrNull(target) !== null, `链接指向的文件不存在：${path}（解析成 ${target}）`);
  }
});

function readOrNull(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; }
}
