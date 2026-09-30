#!/usr/bin/env node
/**
 * ① `/api/coach` 真 HTTP 往返（harness-verifier 独立入口）
 *   配方照 tests/server.test.js:12-18：进程内 server.listen(0) → /api/bootstrap 取 cookie+csrf
 *   → RSA-OAEP 加密 POST /api/connect → 带 Origin/Cookie/X-Coach-CSRF POST /api/coach。
 *   引擎：自建 createRocoService（不碰 8765），桥用 configureRocoTools({client}) 指过去。
 *   模型：假 fetchImpl —— 证据阶段回 `{"tool":"plan_actions","args":{真公开面}}`，其余回正文。
 * 用法：node scripts/roco/verify-coach-http.mjs [ROOT]
 */
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const {createCoachServer} = await import(`file:///${R}/src/server/index.js`);
const {createRocoService} = await import(`file:///${R}/src/server/roco-service.js`);
const {configureRocoTools} = await import(`file:///${R}/src/coach/toolbox.js`);

const say = (...a) => console.log(...a);
let planCalls = 0;
let lastPayload = null;
const service = createRocoService({repoRoot: ROOT});
let server = null;

try {
  // 1) 真引擎：取真公开面
  const roster = await service.roster({limit: 12});
  const six = (roster.pets ?? []).map((p) => p.pet_id).slice(0, 6);
  const b = await service.startBattle({mode: 'demo-training-3v3', team: six.slice(0, 3), seed: 11});
  say('startBattle.ok =', b.ok, '| battle_id =', b.battle_id);
  const client = service._client();
  const legal = await client.battleLegal({state: service._sessions.get(b.battle_id).state,
    strategy: 'greedy_damage', stateVersion: 0});
  const pub = legal?.ok === true ? (legal.result?.public ?? legal.result?.planner_public) : null;
  say('真公开面 =', pub ? `keys=${Object.keys(pub).length} state_version=${pub.state_version}` : null);
  if (!pub) throw new Error('拿不到真公开面');

  const origPlan = client.planActions.bind(client);
  client.planActions = async (payload, opts) => {
    planCalls += 1;
    lastPayload = payload;
    return origPlan(payload, opts);
  };
  configureRocoTools({client, stateVersion: () => pub.state_version});

  // 2) 假模型
  let round = 0;
  const fetchImpl = async (_url, args) => {
    round += 1;
    const body = args?.body ? JSON.parse(args.body) : {};
    const sys = String(body.messages?.[0]?.content ?? '');
    const wantsTool = /工具|tool/i.test(sys);
    say(`  [fetchImpl #${round}] messages=${body.messages?.length} tools=${body.tools?.length ?? 0} ` +
        `含工具词=${wantsTool} head=${sys.slice(0, 40).replace(/\n/g, ' ')}`);
    const payload = wantsTool
      ? {choices: [{message: {content: JSON.stringify({tool: 'plan_actions',
          args: {state: pub, state_version: pub.state_version}})}}]}
      : {choices: [{message: {content: '这一手按规划器给的建议来，先稳住血量再换人。'}}]};
    return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
  };

  // 3) 进程内 coach server + 配置远程模型
  server = createCoachServer({fetchImpl});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  say('coach server @', base);
  let cookie = '';
  const bs = await fetch(base + '/api/bootstrap', {headers: cookie ? {Cookie: cookie} : {}});
  if (bs.headers.get('set-cookie')) cookie = bs.headers.get('set-cookie').split(';')[0];
  const boot = await bs.json();
  say('/api/bootstrap =', bs.status, '| csrf 有 =', Boolean(boot.csrf), '| configured =', boot.configured);

  const {webcrypto} = await import('node:crypto');
  const key = await webcrypto.subtle.importKey('spki', Buffer.from(boot.publicKey, 'base64'),
    {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  const enc = Buffer.from(await webcrypto.subtle.encrypt('RSA-OAEP', key,
    Buffer.from(JSON.stringify({key: 'sk-fixture-key-for-verify-0001', nonce: boot.nonce})))).toString('base64');
  const con = await fetch(base + '/api/connect', {method: 'POST', headers: {Origin: base, Cookie: cookie,
    'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify({encryptedKey: enc, model: 'deepseek-flash'})});
  say('/api/connect =', con.status, '| 体 =', (await con.text()).slice(0, 120));

  const payload = {
    message: '对手现在血量很高，我这回合该怎么打？',
    role: 'auto',
    context: {mode: 'camp', profile: {pets: [{id: six[0], name: '喵喵'}]}},
    memory: {version: 1, items: []},
    stateToken: pub.state_version ?? 0,
    conversation: [],
  };
  const post = (p, data) => fetch(base + p, {method: 'POST', headers: {Origin: base, Cookie: cookie,
    'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf}, body: JSON.stringify(data)});

  const res = await post('/api/coach', payload);
  const raw = await res.text();
  say('\n=== /api/coach 真读数 ===');
  say('  HTTP 状态 =', res.status);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* 非 JSON */ }
  say('  响应键 =', parsed ? Object.keys(parsed).sort().join(',') : '(非 JSON)');
  say('  provider =', parsed?.provider, '| route =', parsed?.route, '| error =', parsed?.error ?? null);
  say('  text 长度 =', parsed?.text ? parsed.text.length : null);
  say('  原文含 opponent_scenarios =', /opponent_scenarios|opponentScenarios/.test(raw));
  say('  桥侧 planActions 调用次数 =', planCalls);
  if (lastPayload) {
    say('  桥侧实际发出的键 =', Object.keys(lastPayload).sort().join(','));
    say('  桥侧带 opponent_scenarios =', Array.isArray(lastPayload.opponent_scenarios),
        '| 条数 =', lastPayload.opponent_scenarios?.length ?? 0);
  }
  if (res.status !== 200) say('  失败原文（前 300 字）:', raw.slice(0, 300));
} catch (error) {
  say('!! 探针抛错 =', error?.name, error?.message);
  say('   stack:', String(error?.stack ?? '').split('\n').slice(0, 4).join(' | '));
} finally {
  try { server?.closeAllConnections?.(); server?.close(); } catch { /* ignore */ }
  try { await service.stop(); } catch { /* ignore */ }
}
