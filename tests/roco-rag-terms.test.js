// L5 术语库的守卫（本轮新增语料：`data/roco/normalized/roco-world-s4-2026-09-10/terms.json`）。
//
// 为什么这一组必须存在（人类 2026-09-25 在 c21/c22/c23 的批注：「这一大类规则类问题建议问模型，
// **并预制相关规则知识库进 RAG**，快速查询判断」）：
// 冻结语料里有 **54 条游戏内术语**（1015 应对 / 1020 先手 / 3019 选择 / 3009 离场…），
// 而 RAG 的 `libs.json` 里 L5（term_entry）与 L4（tactic_card）一直是 `status: pending` ——
// **一篇都检索不到**。规则类问句只能靠模型记忆，正是那几条批注要修的东西。
//
// 四条判据 + 两条反证：
//   ① 库注册表：L5 是 `ready`、`record_kinds=['term_entry']`、输入路径**真的在磁盘上**；
//   ② 文档：54 篇 `term::*`，全部 `scope='rule'`，每篇都带真 provenance（artifact_path + sha + pointer）；
//   ③ 检索：**定义型**问句（「应对是什么意思」）top-1 是术语原文；
//   ④ **反证**：只是话题上碰到那个词、问的并不是定义的问句（「属性倍率一共有哪几档」），
//      术语**不许**当候选 —— L5 上线当天实测它把 M07 的正确文档挤掉了；
//   ⑤ **反证**：把输入路径指向不存在的文件 ⇒ 必须抛（库声明了真源、真源不在，不许静默变空库）。
//
// 用法：`node --test tests/roco-rag-terms.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {LIBS_PATH, REPO_ROOT, loadLibs} from '../src/coach/rag-libs.js';
import {loadCorpus, buildDocuments, createRagIndexSet, searchIndex, termsInput} from '../src/coach/rag-index.js';

const TERM_IDS = ['1015', '1020', '3009', '3019'];

test('判据①：L5 是 ready、只收 term_entry，输入路径在磁盘上', () => {
  const {libs} = loadLibs();
  const l5 = libs.find((lib) => lib.lib_id === 'L5');
  assert.ok(l5, `${LIBS_PATH} 里必须有 L5`);
  assert.equal(l5.status, 'ready', 'L5 不许退回 pending（退回=规则类问句又检索不到术语）');
  assert.deepEqual(l5.record_kinds, ['term_entry']);
  assert.equal(l5.scope, 'rule');
  const spec = termsInput();
  assert.ok(spec, 'termsInput() 必须解析出 L5 的输入路径');
  assert.ok(existsSync(join(REPO_ROOT, spec.path)), `输入路径不存在：${spec.path}`);
});

test('判据②：54 篇 term 文档，全部 rule scope，每篇都有真 provenance', () => {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/terms.json'), 'utf8'));
  const want = Object.keys(raw.terms ?? {});
  assert.equal(want.length, 54, '冻结语料的术语条数变了，先核对再改这条');
  const docs = buildDocuments(loadCorpus()).filter((doc) => doc.record_kind === 'term_entry');
  assert.equal(docs.length, want.length, `术语文档数应当等于语料条数（${want.length}）`);
  for (const doc of docs) {
    assert.equal(doc.scope, 'rule', `${doc.id} 必须是规则语料（默认检索要能看见）`);
    assert.equal(doc.lib_id, 'L5', `${doc.id} 的 lib_id 必须是 L5`);
    assert.equal(doc.provenance.length, 1, `${doc.id} 必须带一条 provenance`);
    const [prov] = doc.provenance;
    assert.match(prov.pointer, /^terms\.\d+$/, `${doc.id} 的 pointer 必须指到 terms.<id>`);
    assert.ok(prov.artifact_sha256 && prov.artifact_sha256.length === 64, `${doc.id} 缺 artifact sha`);
  }
  for (const id of TERM_IDS) {
    assert.ok(docs.some((doc) => doc.id === `term::${id}`), `必须有 term::${id}`);
  }
});

test('判据③：定义型问句的 top-1 就是术语原文', () => {
  const set = createRagIndexSet(loadCorpus());
  const cases = [['应对是什么意思', 'term::1015'], ['先手+1 是什么意思', 'term::1020'], ['选择 定义', 'term::3019']];
  for (const [query, want] of cases) {
    const result = searchIndex(set.joint, query, {limit: 3, includePlayer: false});
    assert.equal(result.results[0]?.id, want, `${query} 的 top-1 应当是 ${want}`);
    const body = set.joint.byId.get(want)?.body ?? '';
    assert.ok(body.length > 0, `${want} 的正文不许为空`);
  }
});

test('判据④（反证）：只是话题上碰到那个词的问句，术语不许当候选', () => {
  // 实测对照：加库当天 M07「属性倍率一共有哪几档」被 `term::3014`（属性**增减**，不是倍率档位）顶掉。
  const set = createRagIndexSet(loadCorpus());
  const result = searchIndex(set.joint, '属性倍率一共有哪几档', {limit: 5, includePlayer: false});
  assert.ok(!result.results.some((row) => row.record_kind === 'term_entry'),
    `非定义型问句里不该出现术语文档，实际 ${result.results.map((r) => r.id).join('、')}`);
});

test('判据⑤（反证）：输入路径不存在 ⇒ 抛（不许静默变成空库）', () => {
  const broken = {libs: loadLibs().libs.map((lib) => (lib.lib_id === 'L5'
    ? {...lib, inputs: ['data/roco/normalized/does-not-exist/terms.json']} : lib))};
  assert.throws(() => loadCorpus({libs: broken.libs}), /输入路径不存在/);
});
