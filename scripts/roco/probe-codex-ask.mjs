#!/usr/bin/env node
// 「图鉴问句」（`<名字>的<字段>`）这条路**单独**跑一遍，看看它在哪一格断掉。
//
// 为什么要有它：真机探针发现「喵喵的种族值是多少？」这类**最自然的问法**在 8765 上答的是
// 占位句「这一问的答案在图鉴里，我先查一下再答。」（`agentStop` 也没有）—— 也就是说玩家拿到的是
// 一句**承诺**而不是答案。这一支用**桩桥**把这条链逐格打出来（政策 → 参数 → 合法性 → 本地事实 → 收口），
// 不依赖真引擎、不联网。
//
// 用法：node scripts/roco/probe-codex-ask.mjs ["喵喵的种族值是多少？"]
import {buildContext, policyFor, defaultArgsFor, localFactAsk, runCoach, codexFactAsk, codexTarget, codexLookupEnabled, withRuntimeStateVersion, requiredTool} from '../../src/coach/runtime.js';
import {configureRocoTools, resetRocoTools, validToolArgs} from '../../src/coach/toolbox.js';
import {freshMemory} from '../../src/coach/memory.js';

const question = process.argv[2] ?? '喵喵的种族值是多少？';

/**
 * `--live`：不打桩，直接问**真服务**（默认 8765）—— 真机复现用。
 *
 * 与桩桥那一支的区别：这一支能看见**真引擎**的回执形状与出处（`evidence`），
 * 桩桥只能验"接线对不对"。真机那一轮的原始记录（`agentStop/provider/toolTrace`）
 * 就在这里打出来，不许只凭桩桥说"修好了"。
 */
if (process.argv.includes('--live')) {
  const origin = process.env.ORIGIN ?? 'http://127.0.0.1:8765';
  const boot = await fetch(`${origin}/api/bootstrap`);
  const cookie = boot.headers.get('set-cookie')?.split(';')[0];
  const session = await boot.json();
  const questions = [question, ...process.argv.slice(3).filter((x) => !x.startsWith('--'))];
  for (const q of questions) {
    const response = await fetch(`${origin}/api/coach`, {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie, origin, 'X-Coach-CSRF': session.csrf},
      body: JSON.stringify({message: q, role: 'auto', context: {mode: 'camp', profile: {pets: []}},
        memory: freshMemory(), conversation: []}),
    });
    const data = await response.json();
    console.log(`\n【${q}】`);
    console.log('  正文  :', String(data.text ?? data.error ?? '').slice(0, 220));
    console.log('  收口  :', `provider=${data.provider} agentStop=${data.agentStop}`,
      `工具=[${(data.toolTrace ?? []).map((t) => `${t.tool}:${t.args?.kind ?? '-'}:${t.result?.ok}`).join(' ')}]`);
    console.log('  出处  :', JSON.stringify(data.evidence ?? []).slice(0, 260));
  }
  process.exit(0);
}

const bridge = {
  baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
  async query(fact) {
    if (fact.kind === 'pet') {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:pets.json#pet_000001'], error_type: null, failure_class: null,
        result: {record: 'pet', pet_id: 'pet_000001', name: '喵喵', title: '喵喵', types: ['草系'],
          stats: {hp: 65, atk: 66, def: 49, spa: 66, spd: 91, spe: 33}, stat_total: 370,
          feature_skill_id: 'skill_000003',
          learnset_summary: {total: 16, native: 16, blood: 0, stones: 0}}};
    }
    return {ok: false, error: `桩桥没有这一路：${JSON.stringify(fact)}`, error_type: 'stub', failure_class: 'stub'};
  },
};

configureRocoTools({client: bridge, stateVersion: 0});
try {
  const context = buildContext(null, {pets: []}, null, null, 'meadow', question);
  const policy = policyFor(question, context);
  const args = policy.need ? defaultArgsFor(policy.need, context, question) : null;
  console.log('① policy      :', JSON.stringify(policy));
  console.log('①b 开关/问句/目标:', codexLookupEnabled(), codexFactAsk(question),
    JSON.stringify(codexTarget(question)), '| requiredTool:', requiredTool(question, context));
  const withVersion = withRuntimeStateVersion('query_rules', args, context);
  console.log('② args        :', JSON.stringify(args), '→ 补版本后', JSON.stringify(withVersion));
  console.log('③ 参数合法     :', withVersion ? validToolArgs('query_rules', withVersion) : '（没有 need）');
  console.log('④ localFactAsk:', localFactAsk(question, policy));
  for (const name of ['local', 'stub-planner']) {
    const provider = {name, async plan() { return {stop: true}; },
      async generate() { return '（桩模型不该被叫）'; }};
    const answer = await runCoach({message: question, role: 'auto', context, memory: freshMemory(), provider});
    console.log(`⑤ provider=${name} → 收口:`, answer.provider, '| agentStop:', answer.agentStop,
      '| 工具次数:', (answer.toolTrace ?? []).length, '| verified:', answer.verified);
    console.log('   正文:', String(answer.text).slice(0, 160));
    console.log('   回执:', JSON.stringify((answer.toolTrace ?? []).map((t) => ({tool: t.tool,
      ok: t.result?.ok ?? null}))));
  }
} finally {
  resetRocoTools();
}
