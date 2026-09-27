// 产品路径的"能力缺口"探针：把玩家真会问的几句话逐条打给真服务 + 真模型，
// 打印它调了什么工具、依据行是什么、正文说了什么。只测不改。
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8930';
const SIX = [['pet_000012','铠甲虫'],['pet_000062','音速犬'],['pet_000100','仪式巨像'],
  ['pet_000112','雪影娃娃'],['pet_000118','皇家狮鹫'],['pet_000124','化蝶']].map(([id,name])=>({id,name}));
const POOL = [{id:'pet_000417',name:'圆号鱼'},{id:'pet_000062',name:'音速犬'}];
const QUESTIONS = [
  '喵喵学得到哪些技能？',            // 学习表：引擎只认 pet_id
  '我这六只谁速度最快？',            // 六只的数值：包里没有速度
  '「应对」这条术语是怎么定义的？',  // 上一轮已修（回归对照）
  '第三只换成圆号鱼好不好？',        // 上一轮已修（六只 → 应如实说边界）
  '能量上限是几个豆？',              // 固定规则：不该调工具
  '这个阵容打 PVP 有什么短板？',      // 阵容约束：引擎按 3 只算
];
const boot = await fetch(`${ORIGIN}/api/bootstrap`);
const cookie = boot.headers.get('set-cookie')?.split(';')[0];
const session = await boot.json();
if (!session.configured) { console.error('服务没配 key'); process.exit(2); }
const out = [];
for (const message of QUESTIONS) {
  const started = Date.now();
  const res = await fetch(`${ORIGIN}/api/coach`, {
    method: 'POST',
    headers: {Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': session.csrf},
    body: JSON.stringify({message, role: 'companion',
      context: {battle: null, mode: 'camp', profile: {lineup: SIX, pets: POOL}},
      memory: {version: 1}, conversation: []}),
    signal: AbortSignal.timeout(70000),
  });
  const a = await res.json();
  const row = {message, status: res.status, ms: Date.now() - started, agentStop: a.agentStop ?? null,
    text: a.text ?? a.error ?? null, activityLine: a.activityLine ?? null,
    tools: (a.toolTrace || []).map((t) => `${t.tool}${t.result?.missing ? '(缺参)' : t.result?.ok === false ? '(被拒)' : ''}`),
    args: (a.toolTrace || []).map((t) => t.args)};
  out.push(row);
  console.log(`\n问：${message}`);
  console.log(`  agentStop=${row.agentStop} | 工具=[${row.tools.join(', ')}] | ${row.ms}ms`);
  console.log(`  答：${String(row.text).replace(/\s+/g, ' ').slice(0, 120)}`);
  console.log(`  依据：${row.activityLine ?? '（无）'}`);
}
process.stdout.write(`\nJSON ${JSON.stringify(out)}\n`);
