// 比较两只精灵的产品路径探针：agent 该不该自己按名字各查一次？
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8970';
// 引擎真值（用 pet_id 查出来的；手写过一版导致夹具与产品不一致）
const STATS = {
  pet_000012: {hp:132, atk:95, def:128, spa:43, spd:82, spe:75},
  pet_000062: {hp:85, atk:116, def:101, spa:38, spd:82, spe:120},
  pet_000100: {hp:106, atk:84, def:115, spa:89, spd:119, spe:85},
  pet_000112: {hp:130, atk:103, def:66, spa:98, spd:130, spe:90},
  pet_000118: {hp:107, atk:116, def:127, spa:69, spd:65, spe:120},
  pet_000124: {hp:53, atk:46, def:66, spa:46, spd:66, spe:100},
};
const SIX = [['pet_000012','铠甲虫'],['pet_000062','音速犬'],['pet_000100','仪式巨像'],
  ['pet_000112','雪影娃娃'],['pet_000118','皇家狮鹫'],['pet_000124','化蝶']]
  .map(([id,name])=>({id,name,stats:STATS[id]}));
const QUESTIONS = [
  '喵喵和音速犬哪个速度更快？',
  '水蓝蓝和火花谁更肉？',
  '喵喵和铠甲虫哪个物攻高？',
];
const boot = await fetch(`${ORIGIN}/api/bootstrap`);
const cookie = boot.headers.get('set-cookie')?.split(';')[0];
const session = await boot.json();
if (!session.configured) { console.error('服务没配 key'); process.exit(2); }
for (const message of QUESTIONS) {
  const started = Date.now();
  const res = await fetch(`${ORIGIN}/api/coach`, {method: 'POST',
    headers: {Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': session.csrf},
    body: JSON.stringify({message, role: 'companion',
      context: {battle: null, mode: 'camp', profile: {lineup: SIX, pets: [{id:'pet_000417',name:'圆号鱼'}]}},
      memory: {version: 1}, conversation: []}),
    signal: AbortSignal.timeout(70000)});
  const a = await res.json();
  const tools = (a.toolTrace || []).map((t) => `${t.tool}${JSON.stringify(t.args)}`);
  console.log(`\n问：${message}`);
  console.log(`  agentStop=${a.agentStop} | ${Date.now() - started}ms | 调用 ${tools.length} 次`);
  tools.forEach((t) => console.log(`    ${t.slice(0, 96)}`));
  console.log(`  答：${String(a.text || a.error).replace(/\s+/g, ' ').slice(0, 120)}`);
  console.log(`  依据：${a.activityLine ?? '（无）'}`);
}
