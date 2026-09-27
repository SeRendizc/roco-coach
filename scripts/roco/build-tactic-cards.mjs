// L4 战术卡库的派生产物：把 `src/game/content.js` 里的 93 张卡导成 `data/roco/derived/tactic-cards.json`。
//
// 为什么要有这一步（而不是让 RAG 直接 import `content.js`）：
//   · `loadCorpus()` 是**同步**的，有十来个同步调用点（评测、校验脚本、判据）；
//     为了一个库把整条链改成 async 不划算；
//   · 卡片是 JS 模块（`export const TACTIC_CARDS`/`REFERENCE_CARDS`），没有 JSON 真源可读。
// 所以走本仓已有的派生数据套路（`on-demand-builds` / `pvp-magic` / `pet-mechanisms` 同款）：
// 生成 → 产物里记 `source_sha256` → `--check` 与判据一起钉住「改卡片不重跑」这件事。
//
// 用法：
//   node scripts/roco/build-tactic-cards.mjs            # 写产物
//   node scripts/roco/build-tactic-cards.mjs --check    # 与"现在重算"逐字节比，不一致退出 1

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const SOURCE = 'src/game/content.js';
export const OUT = 'data/roco/derived/tactic-cards.json';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 读卡片并产出**确定性**的产物对象（同样的源 ⇒ 逐字节相同）。 */
export async function build({root = ROOT} = {}) {
  const sourcePath = join(root, SOURCE);
  if (!existsSync(sourcePath)) throw new Error(`卡片真源不存在：${SOURCE}`);
  const sourceText = readFileSync(sourcePath, 'utf8');
  const mod = await import(pathToFileURL(sourcePath).href);
  const cards = [...(mod.TACTIC_CARDS ?? []), ...(mod.REFERENCE_CARDS ?? [])];
  if (!cards.length) throw new Error(`${SOURCE} 里没有 TACTIC_CARDS / REFERENCE_CARDS`);
  // 字段**逐个显式取**（不是 `...card`）：卡片以后加字段时，RAG 里出现什么是显式决定，不是顺带漏进来。
  const rows = cards.map((card) => ({
    id: String(card.id ?? ''),
    title: String(card.title ?? ''),
    keywords: String(card.keywords ?? ''),
    principle: String(card.principle ?? ''),
    counterexample: String(card.counterexample ?? ''),
    authority: [...(card.authority ?? [])].map(String),
    conditions: [...(card.conditions ?? [])].map(String),
    rules_version: String(card.rulesVersion ?? ''),
    game: String(card.game ?? ''),
    status: String(card.status ?? ''),
  }));
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error('卡片 id 有重复 —— 文档 id 必须唯一');
  for (const row of rows) {
    if (!row.id) throw new Error('有卡片没有 id');
    if (!row.principle) throw new Error(`卡片 ${row.id} 没有 principle（正文会空）`);
  }
  return {
    schema: 'roco-tactic-cards/v1',
    generated_by: 'scripts/roco/build-tactic-cards.mjs',
    source: SOURCE,
    source_sha256: sha256(sourceText),
    why: 'L4 战术卡库的派生真源：卡片本体在 src/game/content.js，这里只做导出与指纹。'
      + '改卡片不重跑这个脚本 ⇒ source_sha256 对不上 ⇒ 判据红。',
    counts: {tactic: (mod.TACTIC_CARDS ?? []).length, reference: (mod.REFERENCE_CARDS ?? []).length,
             total: rows.length},
    cards: rows,
  };
}

const main = async () => {
  const check = process.argv.includes('--check');
  const built = await build();
  const outPath = join(ROOT, OUT);
  const text = `${JSON.stringify(built, null, 2)}\n`;
  if (check) {
    if (!existsSync(outPath)) {
      console.error(`✗ 产物不存在：${OUT}（跑 node scripts/roco/build-tactic-cards.mjs）`);
      process.exit(1);
    }
    const onDisk = readFileSync(outPath, 'utf8');
    if (onDisk !== text) {
      const a = JSON.parse(onDisk);
      const replay = {onDisk, built, template: null};
      const why = a.source_sha256 !== built.source_sha256
        ? `卡片真源变了（产物记 ${String(a.source_sha256).slice(0, 8)}…，现在 ${built.source_sha256.slice(0, 8)}…）`
        : `产物与重算不同但真源没变（条数 ${a.cards?.length} vs ${built.cards.length}）`;
      console.error(`✗ ${OUT} 与"现在重算"不一致：${why}\n  跑 node scripts/roco/build-tactic-cards.mjs 重新生成`);
      process.exit(1);
    }
    console.log(`✔ ${OUT} 与现在重算一致（${built.counts.total} 张卡；真源指纹 ${built.source_sha256.slice(0, 12)}…）`);
    return;
  }
  mkdirSync(dirname(outPath), {recursive: true});
  writeFileSync(outPath, text);
  console.log(`wrote ${OUT}（${built.counts.total} 张卡：战术 ${built.counts.tactic} + 参考 ${built.counts.reference}）`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
