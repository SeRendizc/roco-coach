// RC-901 R4 的**纯逻辑**判据（`src/coach/answer-cache.js`）。
//
// 规划出处 `docs/roadmap/MODEL-ROUTING-PLAN.md` §2.3 建议新增第 1、2 条：
//   「回答缓存：key = `stateToken + role + message 摘要 + 工具回执摘要 + 提示摘要`，命中标 `cache:'hit'`。
//     **反证**：改 `stateToken` 必须 miss。」
// 真服务那一侧的四条在 `tests/server.test.js`（R4①–④）；这里钉**身份函数与缓存的边界**：
//   ① 身份**逐字段**都要有感（改任何一个都必须换 key）——表格化，漏一个就是"把上一局的答案发给下一局"；
//   ② TTL：到点必须 miss（时间由判据注入，不用真等）；
//   ③ 容量：超上限淘汰最老的（不许无限长）；
//   ④ `shouldCache`：只有「走了云端 + 通过守卫 + 不是降级」才进缓存。
import test from 'node:test';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';

import {DEFAULT_TTL_MS, PROMPT_DIGEST, answerCacheKey, createAnswerCache, digestOf, shouldCache}
  from '../src/coach/answer-cache.js';

const BASE = {stateToken: 17, role: 'auto', message: '这回合怎么打',
  context: {mode: 'pve', ruleset_config_id: 'legacy_sim_v1'}, model: 'deepseek-flash',
  rulesVersion: '0.6', promptDigest: PROMPT_DIGEST};

test('判据①：身份逐字段有感（改任何一个都必须换 key）', () => {
  const key = answerCacheKey(BASE);
  const changes = {
    stateToken: {...BASE, stateToken: 18},
    role: {...BASE, role: 'teacher'},
    message: {...BASE, message: '这回合怎么打？'},
    mode: {...BASE, context: {...BASE.context, mode: 'camp'}},
    rulesetConfigId: {...BASE, context: {...BASE.context, ruleset_config_id: 'mobile_s4_candidate_v3'}},
    model: {...BASE, model: 'qwen3.5-4b'},
    rulesVersion: {...BASE, rulesVersion: '0.7'},
    promptDigest: {...BASE, promptDigest: 'deadbeef'},
  };
  for (const [field, input] of Object.entries(changes)) {
    assert.notEqual(answerCacheKey(input), key, `改 ${field} 必须换 key`);
  }
  assert.equal(answerCacheKey({...BASE}), key, '同样的身份必须得到同样的 key');
  assert.match(key, /^[0-9a-f]{8}$/, 'key 是 8 位十六进制指纹（FNV-1a，不引 node:crypto）');
  assert.equal(digestOf({a: 1}), digestOf({a: 1}));
});

test('判据②：TTL 到点必须 miss（时间由判据注入）', () => {
  let now = 1_000_000;
  const cache = createAnswerCache({ttlMs: 1000, clock: () => now});
  const key = 'k';
  cache.set(key, {text: '答案'});
  assert.deepEqual(cache.get(key), {text: '答案'});
  now += 999;
  assert.deepEqual(cache.get(key), {text: '答案'}, '没到点不许过期');
  now += 2;
  assert.equal(cache.get(key), null, '到点必须 miss');
  assert.equal(cache.stats.expired, 1, '过期要单独记账（与"从没存过"分开）');
  assert.equal(DEFAULT_TTL_MS, 60_000);
});

test('判据③：容量上限按插入顺序淘汰最老的', () => {
  const cache = createAnswerCache({maxEntries: 2, clock: () => 0});
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), null, '最老的被淘汰');
  assert.deepEqual([cache.get('b'), cache.get('c')], [2, 3]);
  assert.equal(cache.stats.evicted, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('判据④：只有「走云端 + 过守卫 + 不是降级」的答案才进缓存', () => {
  assert.equal(shouldCache({provider: 'deepseek', text: '答案', validation: {valid: true}},
    {cloudProviderName: 'deepseek'}), true);
  const rejected = [
    ['降级成本地', {provider: 'local-fallback', text: '答案'}, {cloudProviderName: 'deepseek'}],
    ['本地路径', {provider: 'local', text: '答案'}, {cloudProviderName: 'deepseek'}],
    ['守卫判不合格', {provider: 'deepseek', text: '答案', validation: {valid: false}}, {cloudProviderName: 'deepseek'}],
    ['没有云端 provider 名', {provider: 'deepseek', text: '答案'}, {cloudProviderName: null}],
    ['空正文', {provider: 'deepseek', text: ''}, {cloudProviderName: 'deepseek'}],
  ];
  for (const [label, answer, opts] of rejected) {
    assert.equal(shouldCache(answer, opts), false, `${label} 不许进缓存`);
  }
});

test('判据⑤（接线）：服务端真的用缓存与去重，且断开连接/换凭据会清空', () => {
  const {readFileSync} = require('node:fs');
  const src = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/coach\/answer-cache\.js'/, '服务端必须导入这个纯模块');
  assert.match(src, /answerCacheKey\(/, 'key 必须由 `answerCacheKey` 算（不许在服务里拼一份）');
  assert.match(src, /answerCache\.get\(cacheKey\)/, '命中查询必须在路由里');
  assert.match(src, /shouldCache\(answer/, '入缓存必须过 `shouldCache`');
  assert.match(src, /inflightByKey\.has\(cacheKey\)/, '同 key 去重必须按 key 判');
  // 断开与换凭据都要清（key 里没有凭据身份）
  assert.equal((src.match(/answerCache\.clear\(\)/g) || []).length >= 2, true, '断开与换凭据两处都要清缓存');
});
