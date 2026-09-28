// 判据：**交接文档里的关键数字必须与产物一致**（2026-09-28）。
//
// 为什么要有它：交接文档是下一个对话/下一个 agent 的**第一手材料**，里面的数字一旦漂了，
// 后面所有人都会拿它当事实（本仓已经栽过一次：`AGENT-TRAJECTORIES.md` 写死的「4,536 条」当天就过期，
// 于是又补了「文档里那行 N 条必须与产物一致」那条判据）。这一条是同一个套路，钉三件：
//   ① 抓包采用的只数 / 改过值的只数（来自 `full-catalog.json` 的覆盖账）；
//   ② 别名表的组数（1:1 与多形态各几组）；
//   ③ 发版门禁**唯一**未通过的套件名（写错名字，下一个人会去查一个不存在的问题）。
// 数字对不上就红，改文档或改口径都行 —— 但**必须有人重新看一眼**。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = `${ROOT}docs/roadmap/HANDOFF-2026-09-28.md`;
const CATALOG = `${ROOT}data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`;
const ALIASES = `${ROOT}data/roco/derived/hke-2026-09-27/id-aliases.json`;
const GATE = `${ROOT}reports/roco/verification/latest.json`;

test('交接文档的关键数字与产物一致（漂了就红，逼人重看一眼）', () => {
  assert.ok(existsSync(DOC), `交接文档不在：${DOC}`);
  const doc = readFileSync(DOC, 'utf8');
  const grab = (re, what) => {
    const m = doc.match(re);
    assert.ok(m, `文档里找不到「${what}」这一处 —— 判据钉不住它了`);
    return Number(String(m[1]).replace(/,/g, ''));
  };

  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const override = catalog.provenance.stats_override;
  assert.equal(grab(/\*\*(\d+) 只\*\*采用抓包/, '抓包采用只数'), override.matched,
    '文档写的"采用抓包"只数与 full-catalog 的覆盖账对不上');
  assert.equal(grab(/\*\*(\d+) 只\*\*改过六维/, '改过值的只数'), override.changed,
    '文档写的"改过六维"只数和覆盖账对不上');
  // 两条路的只数之和必须等于总数（账本自己也要自洽）
  assert.equal(override.matched_by.game_id + override.matched_by.lord_name, override.matched,
    'overlay 账：按 id 对上的 + 按首领同名对上的 必须等于总数');

  const alias = JSON.parse(readFileSync(ALIASES, 'utf8'));
  // 一次把三个数一起取出来（写成三个各自的正则很容易抓错括号，第一版就踩了）
  const aliasLine = doc.match(/\*\*(\d+) 组\*\*（(\d+) 个 1:1 \+ (\d+) 个多形态/);
  assert.ok(aliasLine, '文档里找不到"**N 组**（A 个 1:1 + B 个多形态）"这一行');
  assert.equal(Number(aliasLine[1]), alias.counts.groups, '别名总组数与产物对不上');
  assert.equal(Number(aliasLine[2]), alias.counts.one_to_one, '1:1 组数与产物对不上');
  assert.equal(Number(aliasLine[3]), alias.counts.multi_form, '多形态组数与产物对不上');

  // 门禁那一条：文档里点名的红项**必须与产物一致**。
  //
  // ⚠ 2026-09-28 改钉（接手轮）：原来写成"文档必须出现『唯一红的是 `X`』这一处"，
  // 那个措辞是在"真的只有一个红"的时候定下的；接手之后红项换过（先 `trajectories-model`，后 `unit`），
  // 于是这条判据变成**在逼文档写一句过期的话**。
  // 改钉后它钉的是**同一件事的两面**：① 文档必须点名红项；② 点名的那个**必须在产物里真的红着**。
  // 反证照旧：产物里没有的红项，文档一个字都不许说它红。
  const gate = JSON.parse(readFileSync(GATE, 'utf8'));
  const failed = Array.isArray(gate.failed) ? gate.failed : [];
  const named = doc.match(/唯一红的是 `([\w-]+)`/);
  const listed = doc.match(/未通过套件[：:]\s*\[([^\]]*)\]/);
  const names = [
    ...(named ? [named[1]] : []),
    ...(listed ? listed[1].split(',').map((x) => x.trim().replace(/["']/g, '')).filter(Boolean) : []),
  ];
  assert.ok(names.length > 0, '文档里既没有"唯一红的是 `X`"，也没有"未通过套件：[…]"这一处');
  for (const name of names) {
    assert.ok(failed.includes(name),
      `文档把 ${name} 写成了红的，产物里未通过的却是 ${JSON.stringify(failed)}`);
  }
});
