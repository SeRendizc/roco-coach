#!/usr/bin/env node
/**
 * 04.1 红线 · Node 侧独立核查：工具层与客户端的 /battle/plan 请求体里到底有什么？
 * 用假客户端把「实际会被发出去的 body/options」抓下来，不需要真引擎。
 * 只读；用法：node scripts/roco/verify-041-node-body.mjs [ROOT]
 */
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const TB = await import(`file:///${R}/src/coach/toolbox.js`);
const RC = await import(`file:///${R}/src/coach/roco-client.js`);

const publicState = {schema_version: 1, state_version: 7, turn: 3, self: {}, opponent: {}};

// 1) 工具层：planActionsViaPlanner 把什么交给客户端？
const seen = [];
const fakeClient = {planActions: async (state, opts) => { seen.push({state, opts}); return {ok: true}; }};
await TB.planActionsViaPlanner({client: fakeClient, state: publicState, state_version: 7, timeoutMs: 1234});
console.log('=== [1] toolbox.planActionsViaPlanner ⇒ client.planActions(state, opts) ===');
console.log('  opts =', JSON.stringify(seen[0]?.opts));
console.log('  state 是同一个公开对象 =', seen[0]?.state === publicState);
console.log('  opts 里有 seed 吗 =', seen[0] && 'seed' in (seen[0].opts ?? {}));

// 2) 客户端：给 options.seed 时，请求体里会出现 seed 吗？（用 _payload 直接算，免得真发请求）
const client = new RC.RocoClient ? new RC.RocoClient({baseUrl: 'http://127.0.0.1:1', rulesetId: 'r'}) : null;
if (client) {
  const body = client._payload({public: publicState}, {stateVersion: 7, seed: 424242, rulesetId: 'r'});
  console.log('\n=== [2] roco-client._payload（带 options.seed）===');
  console.log('  body keys =', Object.keys(body).join(','));
  console.log('  body 里有 seed 吗 =', 'seed' in body, '| 值 =', JSON.stringify(body.seed ?? null));
} else {
  console.log('\n=== [2] 无法实例化 RocoClient（导出名不同）===');
  console.log('  RC exports =', Object.keys(RC).join(','));
}
