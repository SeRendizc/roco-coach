// 导出**全量图鉴**到临时目录，只给本轮审计脚本 read 用，**不进仓库**。
//
// 为什么单独一个脚本、默认写到 tmp/：
//   上游 `rocom-wiki-data` 的许可等级见 `docs/roco/LICENSE-MATRIX.md`；
//   规范化目录里只落了 12 只目标精灵。全量 622 只逐字段导出属于**本地审计用**，
//   所以默认落在 `.gitignore` 覆盖的 `tmp/` 下，不作为分发物。
//
// 用法：
//   node scripts/roco/export-full-catalog.mjs [--out tmp/roco-full-catalog.json]
//
// 只做文本解析（`lua-safe-parse.mjs`），不执行任何第三方 Lua。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { parseLuaTable, luaArrayToArray } from './lua-safe-parse.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const RAW = ROOT + 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? argv[outArg + 1] : ROOT + 'tmp/roco-full-catalog.json';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const arr = (v) => (Array.isArray(v) ? v : luaArrayToArray(v));

const catalogPath = RAW + 'Catalog.lua';
const learnsetsPath = RAW + 'Learnsets.lua';
const catalog = parseLuaTable(readFileSync(catalogPath, 'utf8'), { file: 'Catalog.lua' }).root;
const learnsets = parseLuaTable(readFileSync(learnsetsPath, 'utf8'), { file: 'Learnsets.lua' }).root;

const pets = {};
for (const [pid, p] of Object.entries(catalog)) {
  pets[pid] = {
    pet_id: pid,
    name: p.name,
    title: p.title ?? p.name,
    game_id: p.game_id ?? null,
    number: p.number ?? null,
    types: arr(p.types),
    stats: p.stats,
    release: p.release ?? null,
    learnset_id: p.learnset_id ?? null,
    feature_skill_id: p.feature_skill_id ?? null,
    stage: p.stage ?? null,
    class: p.class ?? null,
  };
}
const ls = {};
for (const [lid, l] of Object.entries(learnsets)) {
  ls[lid] = {
    learnset_id: lid,
    native: arr(l.native_skills).map((x) => x.skill).filter(Boolean),
    blood: arr(l.blood_skills).map((x) => x.skill).filter(Boolean),
    stones: arr(l.skill_stones).filter(Boolean),
    feature_skill: l.feature_skill ?? null,
  };
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  note: '本地审计用全量图鉴导出，**不要提交**（默认路径在 .gitignore 的 tmp/ 下）',
  sources: {
    catalog: { path: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua', sha256: sha256(catalogPath) },
    learnsets: { path: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Learnsets.lua', sha256: sha256(learnsetsPath) },
  },
  pets, learnsets: ls,
}, null, 0) + '\n');
console.log(`OK full-catalog → ${OUT}  pets=${Object.keys(pets).length} learnsets=${Object.keys(ls).length}`);
