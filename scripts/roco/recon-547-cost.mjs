#!/usr/bin/env node
/**
 * 只读工时测量：把「抓包 547 只 → 加密配招层所需的那份数据」这条路**真跑一遍**，量耗时与体积。
 *
 * 它**不改任何仓库数据**：只在内存里组装，把结果写进系统临时目录（`/tmp`），
 * 不是把 547 只灌进 `owned-pets.json` —— 语料形状一个字都没动。
 *
 * 做法（与 `build-roster-48-engine-inputs.mjs` 同口径，但**不改那个脚本**）：
 *   ① 抓包 547 个 id（`.result.pet_detail`）
 *   ② 按 `game_id` 对到 wiki 快照 `Catalog.lua` 的 622 条 → 拿到 `learnset_id`
 *   ③ 从 `Learnsets.lua` 里取出该 learnset 的 `native_skills`（**带 level/stage**）/`blood_skills`/`skill_stones`
 *   ④ 技能名 → `skill_id`（抓包侧要用名字回查）
 *
 * 用法：
 *   node scripts/roco/recon-547-cost.mjs            # 打印实测
 *   node scripts/roco/recon-547-cost.mjs --out /tmp/x.jsonl
 */
import {readFileSync, readdirSync, writeFileSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAWDIR = join(ROOT, 'data/roco/raw/hke-2026-09-27/raw');
const WIKI = join(ROOT, 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data');
const NORM = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10');
const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

// 别名表：4xxx 首领形态 ↔ 5xxx 图鉴条目（多形态时 `catalog_pet_ids` 有多条）。
// 本测量取该组的**第一条**图鉴条目来取学招表，并在输出里标注"多形态取首条"——
// 真正的产品口径要人来定（7 组多形态的六维本来就不许拍平，配招同理）。
const aliases = new Map();
try {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/hke-2026-09-27/id-aliases.json'), 'utf8'));
  for (const g of doc.groups || []) aliases.set(String(g.capture_id), g);
} catch { /* 没有别名表就退回"要人判"那一档 */ }

const t0 = process.hrtime.bigint();
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;
const marks = [];
const mark = (label, from) => marks.push({label, ms: Number(ms(from).toFixed(1))});

// ── ① 抓包 547 ────────────────────────────────────────────────────────
let t = process.hrtime.bigint();
const files = readdirSync(RAWDIR).filter((f) => f.endsWith('.json'));
const captures = new Map();
for (const file of files) {
  const doc = JSON.parse(readFileSync(join(RAWDIR, file), 'utf8'));
  const detail = doc?.result?.pet_detail;
  if (detail?.id == null) continue;
  if (!captures.has(String(detail.id))) captures.set(String(detail.id), {detail, file});
}
mark(`读 ${files.length} 个抓包文件（去重后 ${captures.size} 只）`, t);

// ── ② 技能名 → skill_id ───────────────────────────────────────────────
t = process.hrtime.bigint();
const skills = Object.values(JSON.parse(readFileSync(join(NORM, 'skills.json'), 'utf8')).skills);
const nameToId = new Map(skills.map((s) => [s.name, s.skill_id]));
const idToName = new Map(skills.map((s) => [s.skill_id, s.name]));
mark(`读 skills.json（${skills.length} 条）并建名字索引`, t);

// ── ③ wiki Catalog.lua → pet_id / game_id / learnset_id ───────────────
t = process.hrtime.bigint();
const catalogLua = readFileSync(join(WIKI, 'Catalog.lua'), 'utf8');
const starts = [];
{
  const re = /pet_(\d{6})=\{/g;
  let m;
  while ((m = re.exec(catalogLua))) starts.push({id: `pet_${m[1]}`, at: m.index});
}
const wikiPets = new Map();
for (let i = 0; i < starts.length; i += 1) {
  const seg = catalogLua.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : starts[i].at + 6000);
  const ls = seg.match(/learnset_id="([^"]+)"/);
  const gid = seg.match(/game_id=(\d+)/);
  wikiPets.set(starts[i].id, {learnset_id: ls ? ls[1] : null, game_id: gid ? Number(gid[1]) : null});
}
const byGameId = new Map();
const byName = new Map();
for (const [pid, v] of wikiPets) {
  if (v.game_id != null) byGameId.set(String(v.game_id), pid);
}
{
  // 名字路：4xxx 首领形态在图鉴里是 5xxx，得靠名字接（与 build-full-catalog.mjs 的 lord_name 同思路，
  // 这里只用它**找得到唯一一条**的情形；找得到多条 = 多形态，记为"要人判"，不硬猜）。
  const nameAt = new Map();
  const re = /pet_(\d{6})=\{/g;
  let m;
  while ((m = re.exec(catalogLua))) {
    const seg = catalogLua.slice(m.index, Math.min(catalogLua.length, m.index + 6000));
    const title = seg.match(/title="([^"]+)"/);
    if (!title) continue;
    if (!nameAt.has(title[1])) nameAt.set(title[1], []);
    nameAt.get(title[1]).push(`pet_${m[1]}`);
  }
  for (const [name, pids] of nameAt) {
    if (pids.length === 1) byName.set(name, pids[0]);
  }
}
mark(`读 Catalog.lua（${catalogLua.length} 字节 / ${wikiPets.size} 条）`, t);

// ── ④ Learnsets.lua → 每个 learnset 的四列（带 level/stage） ───────────
t = process.hrtime.bigint();
const learnsetsLua = readFileSync(join(WIKI, 'Learnsets.lua'), 'utf8');
const learnsetAt = new Map();
{
  const re = /(learnset_[0-9a-f]{12})=\{/g;
  let m;
  while ((m = re.exec(learnsetsLua))) learnsetAt.set(m[1], m.index);
}
/** 只截到下一个 learnset 的开头，够用；解析目标只有 native_skills / blood_skills / skill_stones。 */
function sliceLearnset(lid) {
  const at = learnsetAt.get(lid);
  if (at == null) return null;
  const nextAt = [...learnsetAt.values()].filter((x) => x > at).sort((a, b) => a - b)[0] ?? learnsetsLua.length;
  return learnsetsLua.slice(at, nextAt);
}
function ids(list) {
  const out = [];
  const re = /skill="(skill_\d{6})"/g;
  let m;
  while ((m = re.exec(list))) out.push(m[1]);
  return out;
}
function levelsOf(list) {
  const out = [];
  const re = /\{([^{}]*skill="skill_\d{6}"[^{}]*)\}/g;
  let m;
  while ((m = re.exec(list))) {
    const level = m[1].match(/level=(\d+)/);
    const stage = m[1].match(/stage=(\d+)/);
    const blood = m[1].match(/blood="([^"]+)"/);
    const skill = m[1].match(/skill="(skill_\d{6})"/);
    out.push({skill_id: skill ? skill[1] : null,
      level: level ? Number(level[1]) : null,
      stage: stage ? Number(stage[1]) : null,
      blood: blood ? blood[1] : null});
  }
  return out;
}
function blockOf(text, key) {
  const at = text.indexOf(`${key}=`);
  if (at < 0) return '';
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}
mark(`读 Learnsets.lua（${learnsetsLua.length} 字节 / ${learnsetAt.size} 条学招表）`, t);

// ── ⑤ 逐只组装（540 只能按 game_id 直连；7 只多形态记下来） ─────────────
t = process.hrtime.bigint();
let built = 0;
let builtByGameId = 0;
let builtByName = 0;
let aliasOneToOne = 0;
let aliasMultiform = 0;
const unbuilt = [];
const ambiguous = [];
const rows = [];
const cache = new Map();
for (const [captureId, {detail}] of captures) {
  let wikiPid = byGameId.get(captureId);
  let route = 'game_id';
  if (!wikiPid && byName.has(detail.name)) { wikiPid = byName.get(detail.name); route = 'name'; }
  if (!wikiPid) {
    const group = aliases.get(captureId);
    const pid = group?.catalog_pet_ids?.[0] || null;
    if (pid) {
      wikiPid = pid;
      route = group.one_to_one ? 'alias_1to1' : 'alias_multiform_first';
    }
  }
  const lid = wikiPid ? wikiPets.get(wikiPid)?.learnset_id : null;
  if (!lid) {
    if (wikiPid) unbuilt.push({capture_id: captureId, name: detail.name, wiki_pet: wikiPid, why: '无 learnset_id'});
    else ambiguous.push({capture_id: captureId, name: detail.name});
    continue;
  }
  if (!cache.has(lid)) {
    const text = sliceLearnset(lid);
    cache.set(lid, text == null ? null : {
      native: levelsOf(blockOf(text, 'native_skills')),
      blood: levelsOf(blockOf(text, 'blood_skills')),
      stones: ids(blockOf(text, 'skill_stones')),
    });
  }
  const ls = cache.get(lid);
  if (!ls) { unbuilt.push({capture_id: captureId, name: detail.name, why: 'learnset 不在 Lua 里'}); continue; }
  // 抓包侧：三桶名字 → skill_id（这就是"能不能自动生成"的实测）
  const captureIds = {};
  for (const bucket of ['level', 'machine', 'blood']) {
    captureIds[bucket] = (detail.skill_list?.[bucket] || []).map((s) => nameToId.get(s.name) || null);
  }
  rows.push({
    capture_id: captureId,
    name: detail.name,
    learnset_id: lid,
    route,
    native: ls.native.length,
    blood: ls.blood.length,
    stones: ls.stones.length,
    native_with_level: ls.native.filter((e) => e.level != null).length,
    capture_level_resolved: captureIds.level.filter(Boolean).length,
    capture_level_total: captureIds.level.length,
  });
  built += 1;
  if (route === 'game_id') builtByGameId += 1;
  else if (route === 'name') builtByName += 1;
  else if (route === 'alias_1to1') aliasOneToOne += 1;
  else if (route === 'alias_multiform_first') aliasMultiform += 1;
}
mark(`组装 ${built} 只（learnset 去重后实际解析 ${cache.size} 份）`, t);

// ── ⑥ 序列化成最终形态，量体积 ─────────────────────────────────────────
t = process.hrtime.bigint();
const doc = {schema_version: 'probe', learnset_count: rows.length, learnsets: rows};
const json = JSON.stringify(doc, null, 2);
mark(`序列化 ${rows.length} 只（${json.length} 字节）`, t);
mark('合计', t0);

const nativeWithLevel = rows.reduce((s, r) => s + r.native_with_level, 0);
const nativeTotal = rows.reduce((s, r) => s + r.native, 0);
const captureResolved = rows.reduce((s, r) => s + r.capture_level_resolved, 0);
const captureTotal = rows.reduce((s, r) => s + r.capture_level_total, 0);

console.log('=== 547 全量「数据组装」实测（只读，不写仓库数据）===');
console.log(JSON.stringify({
  抓包文件: files.length,
  抓包不同只数: captures.size,
  这次真组装出四列的: built,
  走game_id直连的: builtByGameId,
  走唯一名字接上的: builtByName,
  走别名表_1对1的: aliasOneToOne,
  走别名表_多形态取首条的: aliasMultiform,
  名字在多形态里重复_要人判的: ambiguous.length,
  名字重复的是谁: ambiguous.map((u) => `${u.capture_id}:${u.name}`),
  完全没数据的: unbuilt.length,
  没数据的是谁: unbuilt.map((u) => `${u.capture_id}:${u.name}`),
  wiki学招表去重后实际解析份数: cache.size,
  wiki学招表总数: learnsetAt.size,
  native条目_带level的: `${nativeWithLevel}/${nativeTotal}`,
  抓包level桶_名字能换成skill_id的: `${captureResolved}/${captureTotal}`,
}, null, 2));
console.log('\n耗时（每一步都是实测）:');
for (const m of marks) console.log(`  ${String(m.ms).padStart(8)} ms  ${m.label}`);
if (args.includes('--rows')) for (const r of rows.slice(0, 5)) console.log(JSON.stringify(r));
const out = valueOf('--out');
if (out) { writeFileSync(out, json); console.log(`\n[已写出临时文件] ${out}（${statSync(out).size} 字节）`); }
