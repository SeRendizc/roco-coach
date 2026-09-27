// 把"只能在 Node 里读"的数据文件**生成**成浏览器安全的小模块（`src/coach/*-data.js`）。
//
// 为什么要有这一步（真事故的形状）：`src/coach/**` 会被浏览器页面静态 import，
// 只要图里出现一句 `import ... from 'node:fs'`，浏览器解不出这个协议 ⇒ 整条 import 链**静默**断掉
// （页面标题在、按钮在，但点不动）。守卫在 `tests/evals/structure-contract.test.js`：
// 「浏览器模块图里不许出现 node:*（静态 import）」。
//
// 所以：**数据文件（JSON）仍然是唯一可编辑的源**，浏览器侧用的是这里生成的常量；
// 生成物与源是否一致，由 `tests/roco-talent-nature.test.js` 与
// `tests/roco-nature-advice.test.js` 逐值对拍（不一致就红）。
//
// 用法：node scripts/roco/sync-browser-data.mjs
import {readFileSync, writeFileSync} from 'node:fs';

const root = new URL('../../', import.meta.url);
const banner = (what) => `// ⚠ 自动生成，**不要手改**：源是 ${what}。\n`
  + '// 重新生成：node scripts/roco/sync-browser-data.mjs（判据会逐值对拍，改源不改这里必红）\n';

// ① 30 条性格表
const natures = JSON.parse(readFileSync(new URL('data/roco/systems/natures.json', root), 'utf8'));
const natureRows = natures.natures
  .map((row) => ` {id: ${row.id}, name: '${row.name}', up: '${row.up}', down: '${row.down}'},`)
  .join('\n');
writeFileSync(new URL('src/coach/natures-data.js', root), `${banner('data/roco/systems/natures.json')}
export const NATURES_STAT_ORDER = ${JSON.stringify(natures.stat_order)};
export const NATURES_STAT_NAMES = ${JSON.stringify(natures.stat_names)};
export const NATURES_MODIFIER = ${JSON.stringify(natures.modifier, null, 1).replace(/\n/g, '\n ')};
export const NATURES = [
${natureRows}
];
`, 'utf8');

// ② 622 只的名字（问句里认名字用；只放名字与编号，不放面板数据）
const catalog = JSON.parse(readFileSync(
  new URL('data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', root), 'utf8'));
const rows = Array.isArray(catalog) ? catalog : catalog.pets;
const names = rows.filter((row) => row?.name && row?.stats)
  .map((row) => ` ['${row.name}', '${row.pet_id ?? row.id}'],`).join('\n');
writeFileSync(new URL('src/coach/pet-names-data.js', root), `${banner('data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json')}
export const PET_NAME_ROWS = [
${names}
];
`, 'utf8');
console.log(`已生成：性格 ${natures.natures.length} 条、名字 ${rows.filter((r) => r?.name && r?.stats).length} 条`);
