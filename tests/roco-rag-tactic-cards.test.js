// L4 战术卡库的守卫（本轮新增语料：`data/roco/derived/tactic-cards.json`，真源 `src/game/content.js`）。
//
// 为什么这一组必须存在（人类 2026-09-25 批注：「预制相关规则知识库进 RAG，快速查询判断」）：
// 教练引用得最多的就是 `tactic:*` / `rule:*` 卡片（`answer.knowledge[].id` 就是这套 id），
// 而它们在 RAG 里此前**一篇都检索不到** —— 只有 `searchKnowledge` 那条 IDF 基线能查。
//
// 但把 93 张卡片直接塞进联合索引会**打坏规则检索**（接库当天实测）：
// 卡片关键词极密，把台账/配置挤掉整整一档 —— Recall@1 1.000 → 0.794、等级匹配 1.000 → 0.824，
// 而且 5 条"必须弃答"的事实/证据问句全部变成命中卡片。
// ⇒ 口径：**战术卡只在"要打法/建议"的问句里当候选**（`GUIDANCE_ASK`）。
//
// 五条判据 + 两条反证：
//   ① 库注册表：L4 是 ready、只收 tactic_card、输入（派生产物）在磁盘上；
//   ② 文档：93 篇，id **与真源 `content.js` 的卡片 id 逐条相同**（不信产物，自己 import 复算）；
//   ③ **漂移守卫**：产物里的 `source_sha256` 必须等于当前 `src/game/content.js` 的 sha
//      （改卡片不重跑生成器 ⇒ 这条红）；
//   ④ 正向：要打法的问句 top-1 就是卡片（实测例子）；
//   ⑤ **反证**：事实/证据问句里卡片不许当候选（接库当天就是它们把判据打红的）。
//
// 用法：`node --test tests/roco-rag-tactic-cards.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {LIBS_PATH, REPO_ROOT, loadLibs} from '../src/coach/rag-libs.js';
import {cardsInput, loadCorpus, buildDocuments, createRagIndexSet, searchIndex} from '../src/coach/rag-index.js';

const ARTIFACT = 'data/roco/derived/tactic-cards.json';
const SOURCE = 'src/game/content.js';

test('判据①：L4 是 ready、只收 tactic_card，输入（派生产物）在磁盘上', () => {
  const {libs} = loadLibs();
  const l4 = libs.find((lib) => lib.lib_id === 'L4');
  assert.ok(l4, `${LIBS_PATH} 里必须有 L4`);
  assert.equal(l4.status, 'ready', 'L4 不许退回 pending');
  assert.deepEqual(l4.record_kinds, ['tactic_card']);
  assert.equal(l4.scope, 'rule');
  const spec = cardsInput();
  assert.ok(spec);
  assert.equal(spec.path, ARTIFACT);
  assert.ok(existsSync(join(REPO_ROOT, spec.path)), `输入路径不存在：${spec.path}`);
});

test('判据②：93 篇卡片文档，id 与真源逐条相同', async () => {
  const mod = await import(pathToFileURL(join(REPO_ROOT, SOURCE)).href);
  const truth = [...(mod.TACTIC_CARDS ?? []), ...(mod.REFERENCE_CARDS ?? [])].map((card) => String(card.id));
  assert.equal(truth.length, 93, '卡片条数变了，先核对这条路再改这条');
  const docs = buildDocuments(loadCorpus()).filter((doc) => doc.record_kind === 'tactic_card');
  assert.deepEqual(docs.map((doc) => doc.id), truth, '文档 id 必须与真源卡片 id 逐条一致（教练引用的是这套 id）');
  for (const doc of docs) {
    assert.equal(doc.scope, 'rule');
    assert.equal(doc.lib_id, 'L4');
    assert.equal(doc.provenance[0].artifact_path, ARTIFACT);
    assert.match(doc.provenance[0].pointer, /^cards\[\d+\]$/);
    assert.ok(doc.body.length > 20, `${doc.id} 的正文太短（关键词检索会命中不到）`);
  }
});

test('判据③（漂移守卫）：产物记的 source_sha256 == 当前 content.js 的 sha', () => {
  const artifact = JSON.parse(readFileSync(join(REPO_ROOT, ARTIFACT), 'utf8'));
  const sha = createHash('sha256').update(readFileSync(join(REPO_ROOT, SOURCE), 'utf8')).digest('hex');
  assert.equal(artifact.source_sha256, sha,
    'src/game/content.js 改了但派生产物没重跑 ⇒ 跑 node scripts/roco/build-tactic-cards.mjs');
  assert.equal(artifact.counts.total, 93);
});

test('判据④：要打法的问句 top-1 就是卡片', () => {
  const set = createRagIndexSet(loadCorpus());
  for (const [query, want] of [['我该不该换宠', 'tactic:switch'], ['中毒了怎么办', 'tactic:status-switch'],
    ['对手速度比我快怎么办', 'tactic:priority']]) {
    const result = searchIndex(set.joint, query, {limit: 3, includePlayer: false});
    assert.equal(result.results[0]?.id, want, `${query} 的 top-1 应当是 ${want}`);
  }
});

test('判据⑤（反证）：事实/证据问句里卡片不许当候选', () => {
  // 接库当天：`属性倍率一共有哪几档` 被 `rule:type:electric` 顶掉、
  // `同速时多次录像能看出谁先动吗`（必须弃答）被 `tactic:speed-tie` 顶掉。
  const set = createRagIndexSet(loadCorpus());
  for (const query of ['属性倍率一共有哪几档', '同速时多次录像能看出谁先动吗', '特性触发面都覆盖了哪些时机',
    '技能耗能存在 8 的情况吗']) {
    const result = searchIndex(set.joint, query, {limit: 5, includePlayer: false});
    assert.ok(!result.results.some((row) => row.record_kind === 'tactic_card'),
      `非打法类问句里不该出现卡片：${query} → ${result.results.map((r) => r.id).join('、')}`);
  }
});
