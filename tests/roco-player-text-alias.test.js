/**
 * 玩家文本口径 · **检索别名**（task-42，Lead 窄例外）。
 *
 * 背景：知识卡的 `keywords` 是**检索别名**（`src/coach/rag-index.js` 把 `card.keywords` 当 `aliases`），
 * 不是给玩家读的正文。口径迁移时，卡的正文改成「能量」，而 `keywords` 里**有意保留**旧说法「豆」
 * （玩家的旧叫法，删了召回就退化）。为了让**两种说法都能命中同一张卡**，检索层加了一张
 * legacy 别名表（`LEGACY_QUERY_ALIASES`：豆 → 能量），查询侧也做归一化。
 *
 * 四条判据：
 *   ① 查询里的旧说法「豆」仍能命中该卡；
 *   ② 查询里的新说法「能量」也能命中同一张卡；
 *   ③ 玩家可见**正文**里没有退役单位词（HP/生命/豆）—— `keywords` 是**有意的例外**，单独钉住；
 *   ④ 别名表**只有一处定义**（结构判据，学 `LOADOUT_STORE_*` 的纪律：表只许定义一次，别处只许 import）。
 *
 * 为什么要单开一个判据文件：这两条路（keywords 里的旧词 / 检索层的别名表）**互为备份**，
 * 所以"单删一边"不会红 —— 必须把矩阵钉住（见 task-42 报告），否则将来有人删掉任一边都发现不了。
 *
 * ⚠️ **实测负结果（2026-10-01，必须留档）**：四条变异配置（base / 删别名表 / 删 keywords 里的「豆」/
 *    两边都删）各跑 14 个含旧说法的问句，**检索结果与分数逐位相同**（0/14 有差异）⇒
 *    在这套索引上，「豆」这个信号**不是召回的决定因素**（命中由「防御 / 上限 / 怎么用」等其他 token 与
 *    卡片正文承担）。所以本文件的 ① 里真正判别性的是**展开契约**那两条断言，而 ②③④ 判别的是
 *    「新说法能命中 / 正文干净 / 口径只有一处」；**不要**把这里读成"别名表修好了召回"——
 *    它是**保险**：查询侧始终带一份归一化变体，等哪天真把旧关键词清掉时不必再改检索代码。
 *
 * 跑法：`node --test tests/roco-player-text-alias.test.js`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_QUERY_ALIASES, createRagIndexSet, expandLegacyQuery, loadCorpus, searchIndex,
} from '../src/coach/rag-index.js';
import { TACTIC_CARDS, REFERENCE_CARDS } from '../src/game/content.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 带旧说法「豆」的问句，与带新说法「能量」的问句，指向**同一张卡** `tactic:guard-energy`。 */
const LEGACY_QUERY = '防御回豆怎么用';            // 命中路径：keywords 里的「回豆」+ 别名表展开出的「回能」
const CANONICAL_QUERY = '防御回能的上限为什么是6'; // 命中路径：正文/关键词里的「能量」
const TARGET_CARD = 'tactic:guard-energy';
/** 第二组：`tactic:ether-cost`（keywords「能量果 吃豆 恢复 道具」）与 `tactic:energy-net`。 */
const LEGACY_QUERY_2 = '吃豆划算吗';
const CANONICAL_QUERY_2 = '技能净消耗为什么是1';

const hitsOf = (query) => searchIndex(createRagIndexSet(loadCorpus()).joint, query, { limit: 5, includePlayer: false })
  .results.map((row) => row.id);

test('① 旧说法「豆」的查询仍能命中该卡（keywords + 别名表两条路）', () => {
  assert.ok(hitsOf(LEGACY_QUERY).includes(TARGET_CARD),
    `「${LEGACY_QUERY}」应当命中 ${TARGET_CARD}，实际：${hitsOf(LEGACY_QUERY).join('、')}`);
  assert.ok(hitsOf(LEGACY_QUERY_2).includes('tactic:ether-cost'),
    `「${LEGACY_QUERY_2}」应当命中 tactic:ether-cost，实际：${hitsOf(LEGACY_QUERY_2).join('、')}`);
  // 别名表确实把旧说法展开成了新说法（不是靠巧合命中）
  assert.match(expandLegacyQuery(LEGACY_QUERY), /回能/, '展开后必须带归一化后的「回能」');
  assert.match(expandLegacyQuery(LEGACY_QUERY_2), /吃能量/, '展开后必须带归一化后的「吃能量」');
});

test('② 新说法「能量」的查询命中同一张卡（不依赖 keywords 里的旧词）', () => {
  assert.ok(hitsOf(CANONICAL_QUERY).includes(TARGET_CARD),
    `「${CANONICAL_QUERY}」应当命中 ${TARGET_CARD}，实际：${hitsOf(CANONICAL_QUERY).join('、')}`);
  assert.ok(hitsOf(CANONICAL_QUERY_2).includes('tactic:energy-net'),
    `「${CANONICAL_QUERY_2}」应当命中 tactic:energy-net，实际：${hitsOf(CANONICAL_QUERY_2).join('、')}`);
  assert.equal(expandLegacyQuery(CANONICAL_QUERY), CANONICAL_QUERY, '没有旧说法时展开必须是恒等（不许改查询）');
});

test('③ 玩家可见正文没有退役单位词；keywords 里的旧说法是**有意的例外**', () => {
  const cards = [...TACTIC_CARDS, ...REFERENCE_CARDS];
  const prose = cards.flatMap((c) => [c.title, c.principle, c.counterexample]).filter((x) => typeof x === 'string');
  assert(prose.length >= 200, `正文条数太少（${prose.length}）⇒ 这条判据等于没查`);
  const bad = prose.filter((text) => /\bHP\b|生命|豆/.test(text));
  assert.deepEqual(bad, [], `正文里不许再有退役单位词（HP/生命/豆）：${bad.slice(0, 3).join(' | ')}`);
  // 例外要有据：保留旧说法的 keywords 必须**确实**存在，否则「别名表」就没有服务对象了
  const legacyKeywordCards = cards.filter((c) => typeof c.keywords === 'string' && /豆/.test(c.keywords));
  assert.ok(legacyKeywordCards.length >= 1,
    'keywords 里应当至少保留一处旧说法「豆」（玩家的旧叫法）；若真要清掉，别名表与这条判据必须一起改');
});

test('④ 别名表只有一处定义（结构判据）', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  const definitions = files.filter((p) => /export const LEGACY_QUERY_ALIASES\s*=/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(definitions.map((p) => relative(ROOT, p).split('\\').join('/')), ['src/coach/rag-index.js'],
    '别名表只许在 src/coach/rag-index.js 定义一处');
  // 「换一份近义映射」也算重复定义：全仓只许有一处 `'豆': …` 这种映射形状
  const mappingShapes = files.filter((p) => /['"]豆['"]\s*:/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(mappingShapes.map((p) => relative(ROOT, p).split('\\').join('/')), ['src/coach/rag-index.js'],
    '`豆 → …` 的映射只许有一处（别处只许 import 复用）');
  // 表本身非空、且映射到词表口径
  assert.equal(LEGACY_QUERY_ALIASES['豆'], '能量');
  assert.equal(Object.isFrozen(LEGACY_QUERY_ALIASES), true, '表要冻结：口径不许被就地改');
});
