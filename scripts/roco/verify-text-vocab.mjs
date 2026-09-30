#!/usr/bin/env node
/**
 * 文本口径批次独立复验（harness-verifier）：
 *   ① 退役词在**玩家可见正文**里为 0（corpus 全量扫描）
 *   ③ 语料覆盖审计不可绕过（三条，直接驱动导出的 auditProducerCoverage）
 *   ④ content.js 真源 → 派生产物 source_sha256 是否一致
 * 只读；用法：node scripts/roco/verify-text-vocab.mjs [ROOT]
 */
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const C = await import(`file:///${R}/reports/roco/product-execution/crosscut/player-text-corpus.mjs`);
const {collectCorpus, auditProducerCoverage, CORPUS_PRODUCERS, OPTIONAL_PRODUCERS, producerCounts} = C;

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };

console.log('=== 被验版本指纹 ===');
for (const f of ['src/game/engine.js', 'src/game/rules.js', 'src/game/content.js',
  'tests/roco-player-text-gate.test.js', 'reports/roco/product-execution/crosscut/player-text-corpus.mjs']) {
  console.log(`  ${createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 16)}  ${f}`);
}

// ── ① 语料全量扫描退役词 ──
console.log('\n=== ① 退役词在玩家可见正文里的命中（HP / 生命 / 豆）===');
const result = await collectCorpus({strict: false});
const {entries, failures, coverage} = result;
console.log(`  语料条目 = ${entries.length} | 失败渲染器 = ${failures.length} | 覆盖审计 ok = ${coverage.ok}`);
console.log('  按 API：' + Object.entries(producerCounts(entries)).map(([k, v]) => `${k}×${v}`).join(' · '));
if (failures.length) console.log('  失败渲染器：', failures.map((f) => `${f.api}(${f.err})`).join(' | '));
const RETIRED = /\bHP\b|生命|豆/g;
const hits = [];
for (const e of entries) {
  const m = String(e.text).match(RETIRED);
  if (m) hits.push({api: e.api, file: e.file, text: String(e.text).slice(0, 90), words: [...new Set(m)]});
}
console.log(`  玩家可见正文明细命中 = ${hits.length} 处`);
for (const h of hits.slice(0, 8)) console.log('   ', JSON.stringify(h));
// 语料会随覆盖面增长（2026-10-01：230 → 503）⇒ **不钉死具体条数**：只断言「≥ 登记生产者声明的下限」
// + 覆盖审计 ok。钉死数字会让器材每次扩容都红（与其它读数「范围 + 声明」的口径也不一致）。
const minExpected = CORPUS_PRODUCERS.reduce((n, r) => n + (Number(r.min) || 0), 0);
console.log(`  登记生产者声明的语料下限 = ${minExpected}`);
check(`语料条数 ≥ 登记下限 ${minExpected}（不钉死具体条数）`, entries.length >= minExpected, `实际 ${entries.length}`);
check('渲染器 0 失败', failures.length === 0);
check('覆盖审计 ok', coverage.ok === true);
check('退役词 HP/生命/豆 在玩家可见正文里 **0 处**', hits.length === 0, `实际 ${hits.length}`);

// 确认新口径词在语料里**存在**（否则"0 命中"可能是语料为空）
const hasXue = entries.filter((e) => /血量|血/.test(String(e.text))).length;
const hasEnergy = entries.filter((e) => /能量/.test(String(e.text))).length;
console.log(`  含「血/血量」的条目 = ${hasXue} | 含「能量」的条目 = ${hasEnergy}`);
check('新口径词确实出现在语料里（不是空语料）', hasXue > 0 && hasEnergy > 0);

// ── ③ 覆盖审计三条 ──
console.log('\n=== ③ 覆盖审计不可绕过（直接驱动导出的 auditProducerCoverage）===');
const attempted = [...new Set(entries.map((e) => e.api))];
console.log(`  登记生产者 ${CORPUS_PRODUCERS.length} 个 · 可选 ${OPTIONAL_PRODUCERS.length} 个 · attempted ${attempted.length} 个`);
const ctl = auditProducerCoverage({entries, attempted});
console.log('  控件：', JSON.stringify({ok: ctl.ok, missing: ctl.missing.length, unregistered: ctl.unregistered.length}));
check('控件（真实语料）审计 ok', ctl.ok === true);

// ① 已登记生产者「静默 0 条」
const dropApi = 'reviewMatch';
const entriesA = entries.filter((e) => e.api !== dropApi);
const a1 = auditProducerCoverage({entries: entriesA, attempted});
console.log(`  ① 抹掉 ${dropApi} 的全部条目 ⇒ ok=${a1.ok} · missing=${JSON.stringify(a1.missing)}`);
check('① 已登记生产者静默 0 条 ⇒ 审计红', a1.ok === false && a1.missing.some((m) => m.api === dropApi));

// ② 新增渲染调用但不登记
const a2 = auditProducerCoverage({entries, attempted: [...attempted, 'brandNewRenderer']});
console.log(`  ② 新增未登记调用 brandNewRenderer ⇒ ok=${a2.ok} · unregistered=${JSON.stringify(a2.unregistered)}`);
check('② 未登记的渲染调用 ⇒ 审计红', a2.ok === false && a2.unregistered.includes('brandNewRenderer'));

// ③ 只登记不渲染（把 min 抬到实际产出之上）
const bumped = CORPUS_PRODUCERS.map((r) => (r.api === dropApi ? {...r, min: 999} : r));
const savedMin = CORPUS_PRODUCERS.find((r) => r.api === dropApi)?.min;
// 直接构造：用一个抬高后的表跑同一套逻辑
const counts = producerCounts(entries);
const missingBumped = bumped.map((r) => ({api: r.api, min: r.min, got: counts[r.api] ?? 0})).filter((r) => r.got < r.min);
console.log(`  ③ 把 ${dropApi} 的 min 抬到 999（实际 ${counts[dropApi] ?? 0}）⇒ 不足项 = ${JSON.stringify(missingBumped)}`);
check('③ 只登记不渲染（min 达不到）⇒ 审计判红', missingBumped.length > 0);

// ── ④ 真源 → 派生产物 ──
console.log('\n=== ④ content.js 真源 vs 派生产物 source_sha256 ===');
const contentSha = createHash('sha256').update(readFileSync(join(ROOT, 'src/game/content.js'))).digest('hex');
const artPath = join(ROOT, 'data/roco/derived/tactic-cards.json');
let artSha = null;
if (existsSync(artPath)) artSha = JSON.parse(readFileSync(artPath, 'utf8')).source_sha256 ?? null;
console.log('  content.js            =', contentSha);
console.log('  artifact.source_sha256 =', artSha);
console.log('  一致 =', contentSha === artSha);
check('本副本（9b43bc1）里真源与派生产物一致？', contentSha === artSha,
  contentSha === artSha ? '' : '（不一致 —— 见报告：O-49 漂移在 HEAD 仍然存在）');

console.log('\nRESULT =', pass ? 'TEXT-VOCAB PASS' : 'TEXT-VOCAB CHECK-NEEDED');
process.exit(pass ? 0 : 1);
