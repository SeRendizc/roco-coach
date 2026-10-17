// 活动规则台账「当前 claim」与 RAG 检索的回归判据（2026-10-17，吸收 Codex 审计 A1）。
//
// 背景：台账里 EV-TYPE-MULTIPLIER 的 claim 曾仍是「双属性按两系相乘 / 双克制 ×4」，
// 而 L3 相性文档已是 ×3，两条同时进索引 ⇒ 两条自然问句都返回旧 claim 且不弃答。
// 本文件钉：默认检索**不许**再把退役口径当成当前规则返回；且当前 claim 必须写 ×3。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

import {loadCorpus, createRagIndex, searchIndex} from '../src/coach/rag-index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const index = createRagIndex(loadCorpus({root: ROOT}));

test('① 两条自然问句都不许再返回「双属性按两系相乘 / 双克制 ×4」的当前 claim', () => {
 for (const query of ['属性倍率有哪些档位？', '双属性双克制是几倍？']) {
  const result = searchIndex(index, query, {limit: 1});
  const top = result.results?.[0];
  assert.ok(top, `「${query}」没有检索结果`);
  const title = String(top.title ?? '');
  assert.doesNotMatch(title, /双属性按两系相乘|双克制\s*×4/,
   `「${query}」top-1 仍是退役口径：${top.id} :: ${title}`);
 }
});

test('② 当前台账 claim 必须写「×3」且不得把 ×4 当成档位（活动正文）', () => {
 const result = searchIndex(index, '属性倍率一共有哪几档', {limit: 1});
 const top = result.results?.[0];
 assert.equal(top?.id, 'EV-TYPE-MULTIPLIER', `top-1 应为台账条目，实际：${top?.id}`);
 const body = `${top.title ?? ''}\n${top.body ?? ''}`;
 assert.match(body, /×3/, '当前 claim 必须写双弱 ×3');
 assert.doesNotMatch(body, /双属性按两系相乘|双克制\s*×4/, `当前正文仍含退役口径：${body.slice(0, 200)}`);
});
