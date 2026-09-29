#!/usr/bin/env node
/**
 * task-19 的**秒级复现**：把浏览器那一次局中问句的**原样请求体**（`inbattle-ask-body.json`）
 * 打到**自己的独立实例**上（进程内 `createCoachServer` + `listen(0)` + 自己的引擎子进程），
 * 打印小芽的回答 + 判据读数。
 *
 * 为什么要有它：浏览器那一轮 ~3 分钟（还要抢锁），改一行要看一次读数根本迭代不动。
 * 这一份**不替代**浏览器判据（④ 那条按任务要求仍然在 `inbattle-acceptance.mjs` 里量屏幕），
 * 只用来在改的过程中快速看清"这一支到底走了哪条路、答了什么"。
 *
 * 跑法：node reports/roco/art-finish/inbattle-ask-repro.mjs [--question "……"]
 */

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../../src/server/index.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const BODY_FILE = join(ROOT, 'reports', 'roco', 'art-finish', 'inbattle-ask-body.json');

const argv = process.argv.slice(2);
const qIndex = argv.indexOf('--question');
const overrideQuestion = qIndex >= 0 ? argv[qIndex + 1] : null;
const dIndex = argv.indexOf('--drop');
const dropKeys = dIndex >= 0 ? String(argv[dIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];

const server = createCoachServer({semantic: false, fetchImpl: async () => { throw new Error('复现环境不联网'); }});
await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const boot = await fetch(`${BASE}/api/bootstrap`);
const {csrf} = await boot.json();
const cookie = (boot.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const saved = JSON.parse(readFileSync(BODY_FILE, 'utf8'));
const body = JSON.parse(JSON.stringify(saved.postData));
if (overrideQuestion) body.message = overrideQuestion;
for (const key of dropKeys) delete body.context?.[key];      // 变体：摘掉 roco_plan / roco_battle 等
body.stateToken = `repro-${Date.now()}`;      // 每次都换：不进缓存

const res = await fetch(`${BASE}/api/coach`, {method: 'POST',
  headers: {'Content-Type': 'application/json', 'X-Coach-CSRF': csrf, cookie, Origin: BASE},
  body: JSON.stringify(body)});
const answer = await res.json();
const text = String(answer.text ?? answer.error ?? '');
const battle = body.context?.roco_battle ?? null;
const names = [...(battle?.self ?? []).map((p) => p.name), battle?.foe?.[0]?.name].filter(Boolean);
const hp = [...(battle?.self ?? []).map((p) => p.hp), battle?.foe?.[0]?.hp].filter((x) => Number.isFinite(x));
const detail = {
  question: body.message.slice(0, 40), status: res.status, provider: answer.provider ?? null,
  answerLen: text.length,
  mentionsName: names.filter((n) => text.includes(n)),
  mentionsTurn: new RegExp(`(第\\s*)?${battle?.turn}\\s*(回合|turn)`).test(text),
  mentionsHp: hp.map(String).filter((x) => text.includes(x)),
};
console.log(JSON.stringify(detail, null, 1));
console.log('--- 回答 ---');
console.log(text);
await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
process.exit(detail.mentionsName.length || detail.mentionsTurn || detail.mentionsHp.length ? 0 : 1);
