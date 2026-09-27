// 术语题的产品路径探针（2026-09-25）：问一句玩家真会问的话，看小芽是否**真的去查引擎**。
//
// 用法：先起一个带 key 的产品服务，然后
//   node /tmp/roco-recon/term-probe.mjs "「应对」这条术语是怎么定义的？"
// 环境变量 ROCO_EVAL_ORIGIN（默认 http://127.0.0.1:8932）。
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8932';
const message = process.argv[2] || '「应对」这条术语是怎么定义的？';

const boot = await fetch(`${ORIGIN}/api/bootstrap`);
const cookie = boot.headers.get('set-cookie')?.split(';')[0];
const session = await boot.json();
if (!session.configured) { console.error('服务没配 key'); process.exit(2); }

const started = Date.now();
const res = await fetch(`${ORIGIN}/api/coach`, {
  method: 'POST',
  headers: {Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': session.csrf},
  body: JSON.stringify({
    message, role: 'companion',
    context: {battle: null, mode: 'camp', profile: {pets: []}},
    memory: {version: 1}, conversation: [],
  }),
  signal: AbortSignal.timeout(70000),
});
const answer = await res.json();
if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(answer)); process.exit(3); }
const trace = (answer.toolTrace || []).map((t) => ({
  tool: t.tool, args: t.args, ok: t.result?.ok ?? null,
  error: t.result?.error ?? t.result?.error_type ?? null,
  // 回执里真正有用的那部分（术语题看 note/desc/matches）
  result: t.result?.result ?? t.result ?? null,
}));
console.log(JSON.stringify({
  status: res.status, latencyMs: Date.now() - started,
  provider: answer.provider, agentStop: answer.agentStop, text: answer.text,
  activityLine: answer.activityLine ?? null,
  calls: trace.length, trace,
}, null, 2));
