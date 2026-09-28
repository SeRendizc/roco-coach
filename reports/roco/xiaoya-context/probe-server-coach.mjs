// 服务端 `/api/coach` 在**没有模型密钥**时到底答不答得出洛手的真资料（P0-01 的关键前提）。
//
// 用法：node reports/roco/xiaoya-context/probe-server-coach.mjs [base]
import {buildContext, assembleContext} from '../../../src/coach/runtime.js';
import {freshMemory} from '../../../src/coach/memory.js';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const bootRes = await fetch(`${BASE}/api/bootstrap`);
const cookie = String(bootRes.headers.getSetCookie?.()?.[0] ?? bootRes.headers.get('set-cookie') ?? '').split(';')[0];
const boot = await bootRes.json();
console.log('服务状态：configured=%s verified=%s provider=%s', boot.configured, boot.verified, boot.provider);
console.log('capabilities：', JSON.stringify(boot.capabilities ?? null));

const box = await (await fetch(`${BASE}/api/roco/box?kind=mine&limit=48`)).json();
const profile = {pets: (box.player.cards ?? []).map((card) => ({id: card.select, species_id: card.group,
  name: card.name, types: card.types ?? [], level: card.level ?? null})),
  pool_summary: {total: box.player.total, source: 'owned'}};

const memory = freshMemory();

const QUESTIONS = ['雨天水系伤害加多少？', '火系克制什么属性？', '喵喵的种族值是多少？', '这只的性格是什么？'];
for (const question of QUESTIONS) {
  const raw = buildContext(null, profile, null, null, 'meadow', question);
  raw.coachAllowed = true;
  const assembled = assembleContext({message: question, role: 'auto', context: raw, memory, conversation: [], stateToken: 7});
  const res = await fetch(`${BASE}/api/coach`, {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf, Origin: BASE, Cookie: cookie},
    body: JSON.stringify(assembled.payload)});
  const rawText = await res.text();
  let data = null; try { data = JSON.parse(rawText); } catch { /* 下面按原文报 */ }
  if (!res.ok) { console.log(`\n问：${question}\n→ HTTP ${res.status} ${rawText.slice(0, 200)}`); continue; }
  console.log(`\n问：${question}`);
  console.log(`答：${String(data.text ?? '').slice(0, 320)}`);
  console.log(`（provider=${data.provider} route=${data.route ?? '-'} agentStop=${data.agentStop ?? '-'} localOnly=${data.localOnly} 工具回执=${(data.toolTrace ?? []).length} 条）`);
  for (const receipt of data.toolTrace ?? []) {
    const r = receipt?.result ?? {};
    console.log(`   · ${receipt.tool}：ok=${r.ok} error_type=${r.error_type ?? '-'} ${String(r.message ?? '').slice(0, 80)}`);
  }
}
process.exit(0);
