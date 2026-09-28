// 换招（配招）判据（2026-09-25，人类：「配招这个你得修好」）。
//
// 这一条链有四段，缺一段就"看起来做了、其实没生效"：
//   ① **公开层要给物种 id**：工作台回执的 `player.slots[]` 原来没有 `species_id`，
//      于是页面判「这一只是不是我持有的」**恒为假**（已选槽位全被标成「图鉴 · 按需推算」），
//      换招也无从把配招按物种交给引擎；
//   ② **路由真的存在**：服务方法早就写好了，但 `GET /api/roco/loadout/options` 的路由漏了 ——
//      请求落到通用 POST 分发上得到「仅支持 POST」，界面永远读不到学习表（真机探针抓到）；
//   ③ **引擎真的按换招开局**：`startBattle({loadouts})` 之后公开视图里的 `loadouts`
//      必须是玩家选的那四个（不是规范配招）；
//   ④ **非法配招 fail closed**：学了不存在的技能必须被**引擎**拒（不是这一层说了算）。
//   ⑤ **每个技能都要对准那个精灵**（人类 2026-09-25 口径）：换招的池子不是页面自己猜的 ——
//      页面优先拿**持有实例 id** 去问引擎，服务端解析出物种再回学习表；保存的键用**引擎回执里的
//      `pet_id`**；六个槽位各对各的池子（引擎回的物种与页面解析不一致时如实记 mismatch）。
//      注意架构约束：**`player.slots[]` 里不许补 `species_id`**（工程键属于 dev 段，
//      见 `tests/roco-workshop.test.js` 的「两层分界」）—— 所以物种由引擎裁决，不由页面自报。
//
// 浏览器那一层（真实点击 + 真实请求）由 `scripts/roco/browser-loadout-acceptance.mjs` 负责
// （15/15，其中 05f 逐槽位记下「哪只 = 引擎 pet_id / 可学多少个」证明六份池子互不串味），
// 这里钉可单测的四段。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createRocoService} from '../src/server/roco-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'src', 'server', 'index.js'), 'utf8');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');
const WORKSHOP_SRC = readFileSync(join(ROOT, 'src', 'client', 'team-workshop.js'), 'utf8');
/**
 * 拿六个持有实例（`?team=` 用的就是这种 id）。
 *
 * ⚠ 2026-09-28 改钉：必须取**六个不同物种**的个体 —— 人类批准的那对同种演示个体
 * （`own-0001`/`own-0049`，都是 `pet_000012`）现在是盒子里的前两张卡，
 * 直接 `slice(0,6)` 会把同一物种塞两个槽位，服务端照规矩 400
 * （`DUPLICATE_SPECIES_IN_TEAM`：同种多只个体是**不同练度的选择**，不是两个队员）。
 * 所以要按**物种**去重之后再取 —— 这也是产品真实的口径。
 */
async function ownedSix(service) {
  // `box` 的参数按**查询串**语义收：`limit` 必须是字符串（数字会被判"必须是非负整数"）。
  const box = await service.box({kind: 'mine', limit: '60'});
  const seen = new Set();
  const picked = [];
  for (const row of box?.player?.cards ?? []) {
    if (!row?.select || seen.has(row.group)) continue;
    seen.add(row.group);
    picked.push(row.select);
    if (picked.length >= 6) break;
  }
  return picked;
}

test('① 公开层**不带**工程键，物种由页面按名字唯一匹配解析（两层分界的口径）', async () => {
  const service = createRocoService();
  try {
    const six = await ownedSix(service);
    assert.ok(six.length >= 3, `拿不到足够的持有实例：${JSON.stringify(six)}`);
    const receipt = await service.workshop({selected: six.slice(0, 3).join(',')});
    assert.equal(receipt?.ok, true, `workshop 必须成功：${JSON.stringify(receipt).slice(0, 200)}`);
    const slots = (receipt.player?.slots ?? []).filter((slot) => slot.state === 'filled');
    assert.ok(slots.length >= 1, '至少应有一个已填槽位');
    for (const slot of slots) {
      // 2026-09-25：第一版把 `species_id` 加进 player 段，被「两层分界」判据当场判红 ——
      // 那条规则是对的（id 形状的东西属于 dev 段）。这里把口径钉死：player 段一个工程键都不许有。
      assert.equal('species_id' in slot, false,
        `player 段的槽位不许带 species_id，实际：${JSON.stringify(slot).slice(0, 160)}`);
    }
  } finally {
    await service.stop?.();
  }
  // 物种 id 改由**页面按名字唯一匹配**解析：重名（图鉴 62 个 + 名单里的「棋契陛下」）一律不猜。
  assert.match(WORKSHOP_SRC, /function speciesOfSlot\(slot\)/, '客户端必须有「槽位 → 物种」的解析函数');
  assert.match(WORKSHOP_SRC, /for \(const name of ambiguous\) byName\.delete\(name\);/,
    '重名必须从名字索引里删掉（唯一匹配才算）');
  // 2026-09-25（重名静默丢配招的修法）：**配招过滤不再走名字**。名字索引只用来决定
  // 「给不给换招入口」；「这一局带哪些配招」由工坊按**持有实例**解析出物种 id 后交给主线程。
  assert.match(WORKSHOP_SRC, /teamSpecies: \[\.\.\.new Set\(state\.selected/,
    '工坊必须按持有实例（state.selected → ownedByInstance.speciesId）算出本局物种');
  assert.match(CLIENT_SRC, /teamSpecies: state\.teamWorkshop\?\.teamSpecies/, '主线程要用工坊给的物种列表');
  assert.doesNotMatch(CLIENT_SRC, /speciesIdByName\(slot\?\.name\)/,
    '主线程不许再按名字解析队伍（重名会静默丢配招）');
});

test('② 换招路由必须存在，而且是 **GET**（漏路由的后果是「仅支持 POST」）', () => {
  assert.match(SERVER_SRC, /path==='\/api\/roco\/loadout\/options'&&req\.method==='GET'/,
    'GET /api/roco/loadout/options 路由必须在（否则请求落到通用 POST 分发，界面读到「仅支持 POST」）');
  assert.match(SERVER_SRC, /rocoService\.loadoutOptions\(/, '路由必须真的调用服务方法');
  // 只读接口不该要求 CSRF：与盒子/工坊同一条先例（它们在 POST 网关之前返回）。
  const routeAt = SERVER_SRC.indexOf("/api/roco/loadout/options'&&req.method==='GET'");
  const csrfAt = SERVER_SRC.indexOf("x-coach-csrf");
  assert.ok(routeAt > 0 && csrfAt > routeAt, '换招路由必须排在 POST/CSRF 网关之前（只读、公开数据）');
});

test('③ 引擎真的按换招开局：公开视图里的 loadouts 就是玩家选的那四个', async () => {
  const service = createRocoService();
  try {
    const roster = await service.roster({limit: 12});
    const mine = (roster?.pets ?? []).slice(0, 6).map((pet) => pet.pet_id);
    assert.ok(mine.length === 6, `名单不足六只：${JSON.stringify(mine)}`);
    const options = await service.loadoutOptions({pet: mine[0]});
    assert.equal(options?.ok, true, `学习表必须读得到：${JSON.stringify(options).slice(0, 160)}`);
    const pool = (options.learnable ?? []).map((skill) => skill.skill_id).filter(Boolean);
    assert.ok(pool.length > 4, `可学技能应当多于四个，实际 ${pool.length}`);
    // 故意选**与规范配招不同**的四个：任取池子后四个（规范配招通常是前四个）。
    const chosen = pool.slice(-4);
    const started = await service.startBattle({mode: 'pvp-standard-six-pet', team: mine,
      loadouts: {[mine[0]]: chosen}});
    assert.equal(started?.ok, true,
      `开局必须成功：${JSON.stringify(started).slice(0, 200)}（回执键：${Object.keys(started ?? {}).join(',')}）`);
    // 回执把公开视图放在 `view` 上（不是 `result.view`）。
    const applied = started.view?.self?.loadouts?.[mine[0]] ?? null;
    assert.deepEqual(applied, chosen,
      `引擎回执里 ${mine[0]} 带的必须是玩家选的四个，实际：${JSON.stringify(applied)}`);
  } finally {
    await service.stop?.();
  }
});

test('④ 非法配招必须被引擎拒（fail closed，不是这一层说了算）', async () => {
  const service = createRocoService();
  try {
    const roster = await service.roster({limit: 12});
    const mine = (roster?.pets ?? []).slice(0, 6).map((pet) => pet.pet_id);
    const bogus = ['skill_999991', 'skill_999992', 'skill_999993', 'skill_999994'];
    const started = await service.startBattle({mode: 'pvp-standard-six-pet', team: mine,
      loadouts: {[mine[0]]: bogus}});
    assert.equal(started?.ok, false, '学了不存在的技能必须开局失败');
    assert.equal(started.status, 400, `必须是 400（引擎判的），实际 ${started.status}`);
  } finally {
    await service.stop?.();
  }
});

test('⑤ 客户端的四条硬约束（入口只在持有的槽位上、恰好四个才保存、随 emit 交出去、开局按队伍过滤）', () => {
  // 2026-09-26（玩家可见缺陷：六张卡结构不一致）—— 这一条原来钉的是 `if (!held || !species) return '';`，
  // 而那正是缺陷本身：解析不出物种（图鉴按需推算、或持有名单里重名的「棋契陛下」）时**整行不渲染**，
  // 同一队里有的卡有「换招 / 引擎规范配招」那一行、有的没有，卡片高矮都不一样（截图就是这个）。
  // 现在那一行**六张卡都在**，解析不出来时给**禁用**按钮 + 一句为什么。
  // 口径没有放松：可点的入口仍然只给持有的槽位 —— 所以下面钉三件事：
  //   ① 不持有的走独立分支；② 那一行有「禁用」形态；③ 可点入口全文件**只有一处**且在「持有」判断之后。
  assert.match(WORKSHOP_SRC, /if \(!held \|\| !species\) \{/,
    '换招入口只给**持有**的槽位（按需推算的物种没有可核验学习表）—— 不持有的走禁用分支');
  assert.match(WORKSHOP_SRC, /data-tw-loadout-state="unavailable"/,
    '拿不到可核验学习表时那一行仍然要渲染（禁用 + 说清为什么），否则六张卡结构不一致');
  assert.equal((WORKSHOP_SRC.split('data-tw-loadout="').length - 1), 1,
    '可点的换招入口在源码里必须只有一处渲染点');
  assert.ok(WORKSHOP_SRC.indexOf('data-tw-loadout="')
    > WORKSHOP_SRC.indexOf('const held = Boolean(species) && state.ownedBySpecies.has(species);'),
  '可点的换招入口必须排在「是不是持有」的判断之后（不许给按需推算的物种可点的入口）');
  assert.match(WORKSHOP_SRC, /if \(!editor \|\| editor\.draft\.length !== 4\) return;/,
    '保存必须**恰好四个**（服务端也按四个校验）');
  assert.match(WORKSHOP_SRC, /loadouts: Object\.fromEntries\(\[\.\.\.loadouts\.entries\(\)\]/,
    '工作台必须把换招结果随 detail 交出去（主线程开局要用）');
  assert.match(CLIENT_SRC, /if \(loadouts\) body\.loadouts = loadouts;/,
    '开局请求必须带上 loadouts（没有就不带这个字段）');
  assert.match(CLIENT_SRC, /const loadouts = battleLoadouts\(\{/,
    '只带**当前队伍里**那些（服务端会拒"配招提到了不在这一局里的精灵"）—— 过滤走 battleLoadouts');
});

test('⑥ 每个技能都对准那只精灵：按**持有实例**查，池子按只给，键用引擎回的 pet_id', async () => {
  // 人类 2026-09-25：「每个技能都要对准那个精灵哈 你要拿不准就去查」。
  // 这一条把"去哪查"钉死：**实例 id 交给服务端**（引擎的 resolveBattleTeamIds 解析物种），
  // 而不是页面按名字猜；池子必须**按只给**（不同精灵的数量不同）；换招的键用**引擎回的 pet_id**。
  const service = createRocoService();
  try {
    const box = await service.box({kind: 'mine', limit: '60'});
    const all = box?.player?.cards ?? [];
    assert.ok(all.length >= 2, `盒子里至少要有两只：${JSON.stringify(all.map((c) => c.name))}`);
    // ⚠ 2026-09-28：按**物种**去重后再取三只 —— 人类批准的那对同种演示个体是前两张卡，
    // 取前三只会出现"同一种两只"，而这一条判据要验的是"**不同精灵**的可学池按只给、能区分开"。
    const seenSpecies = new Set();
    const cards = all.filter((card) => {
      if (seenSpecies.has(card.group)) return false;
      seenSpecies.add(card.group);
      return true;
    }).slice(0, 3);
    const seen = [];
    for (const card of cards) {
      const options = await service.loadoutOptions({pet: card.select});
      assert.equal(options?.ok, true, `${card.name} 的学习表必须读得到`);
      assert.match(String(options.pet_id ?? ''), /^pet_\d+$/,
        `${card.name}（实例 ${card.select}）必须被解析成物种 id，实际 ${options.pet_id}`);
      assert.ok((options.learnable ?? []).length > 4,
        `${card.name} 学得到的技能应当多于四个，实际 ${(options.learnable ?? []).length}`);
      // 每一条技能都必须有 id 与名字（页面上要显示名字；id 是交给引擎的那把钥匙）。
      for (const skill of options.learnable) {
        assert.match(String(skill.skill_id ?? ''), /^skill_\d+$/, `技能 id 形状不对：${JSON.stringify(skill)}`);
        assert.ok(typeof skill.name === 'string' && skill.name, `技能必须有名字：${JSON.stringify(skill).slice(0, 120)}`);
      }
      seen.push({name: card.name, pet_id: options.pet_id, total: options.learnable.length});
    }
    // **按只给**：不同精灵的可学池不是同一份（数量或内容上必须能区分开）。
    const keys = new Set(seen.map((row) => `${row.pet_id}:${row.total}`));
    assert.equal(keys.size, seen.length,
      `不同精灵必须各自一份学习表，实际：${JSON.stringify(seen)}`);
  } finally {
    await service.stop?.();
  }
  // 页面侧：优先按实例查、键用引擎回的 pet_id、并如实记录不一致。
  assert.match(WORKSHOP_SRC, /const instance = rows\.find\(\(row\) => typeof row\?\.select === 'string'/,
    '换招必须优先拿**持有实例 id** 去查（引擎解析物种），而不是只按名字猜');
  assert.match(WORKSHOP_SRC, /loadouts\.set\(editor\.petId \?\? editor\.species/,
    '保存的键必须是**引擎回执里的 pet_id**（页面解析只用来找入口）');
  assert.match(WORKSHOP_SRC, /rootEl\.dataset\.twLoadoutMismatch = mismatch \? 'yes' : 'no';/,
    '引擎回的物种与页面解析不一致时必须如实记下来（判据/验收读它）');
});

// ── 2026-09-25（玩家可见的**静默错**）：重名物种的配招被按名字解析丢掉 ────────────────────
// 实测：名单 48 只 / **47 个唯一名字**（「棋契陛下」= pet_000556 与 pet_000575）。
// 原来开局前按名字在名单里解析「本局有哪些物种」，重名 ⇒ 解析 null ⇒ **那一只的配招被静默丢掉**：
// 玩家明明选了四个技能，开局却按引擎的规范配招打 —— 错得很安静。
// 现在：成员由工坊按**持有实例**解析成物种 id（`detail.teamSpecies`），这里只做集合过滤。
import {battleLoadouts} from '../src/coach/roco-experience.js';

const FOUR = ['skill_000645', 'skill_000286', 'skill_000633', 'skill_000648'];

test('⑥ 重名物种的配招必须带上（按实例解析出的物种过滤，不按名字）', () => {
  const loadouts = {pet_000556: ['skill_000001', 'skill_000002', 'skill_000003', 'skill_000004'],
    pet_000575: FOUR.slice(), pet_000999: FOUR.slice()};
  const got = battleLoadouts({loadouts, teamSpecies: ['pet_000556', 'pet_000575', 'pet_000012']});
  assert.deepEqual(Object.keys(got).sort(), ['pet_000556', 'pet_000575'],
    `在本局的两只都要带上、不在本局的不许带：${JSON.stringify(got)}`);
  assert.deepEqual(got.pet_000575, FOUR, '四个技能要逐位带过去');
  // 恰好四个才算数（服务端也按四个校验）
  assert.equal(battleLoadouts({loadouts: {pet_000556: FOUR.slice(0, 3)}, teamSpecies: ['pet_000556']}), null,
    '不足四个不许带（fail closed）');
  // 空集合返回 null：页面据此决定要不要带这个字段
  assert.equal(battleLoadouts({loadouts, teamSpecies: []}), null);
  assert.equal(battleLoadouts({}), null);
  // 兜底路径：没有 teamSpecies 时，只有公开层真带 species_id 才算数
  assert.deepEqual(Object.keys(battleLoadouts({loadouts,
    slots: [{state: 'filled', species_id: 'pet_000575'}, {state: 'empty'}]})), ['pet_000575']);
});

test('⑦ 反证：老口径（只有名字、没有物种 id）必然解析不出来 —— 这就是被修掉的那件事', () => {
  // 公开层的 slot 现在是 {state:'filled', name:'棋契陛下', types:[...]}（**不许带 id**）。
  // 走兜底路径时拿不到 species_id ⇒ 返回 null ⇒ 那只的配招就是被静默丢掉。
  const slots = [{state: 'filled', name: '棋契陛下', types: ['萌系']}];
  assert.equal(battleLoadouts({loadouts: {pet_000575: FOUR.slice()}, slots}), null,
    '没有物种 id 时必须 fail closed（而不是猜一个物种）——这正是老口径在重名上翻车的地方');
  assert.equal(speciesIdByNameIsAmbiguous(), true, '前提：名字「棋契陛下」在名单里确实不唯一');
});

/** 名单里「棋契陛下」是否真的重名（读接口的冻结登记，不手写结论）。 */
function speciesIdByNameIsAmbiguous() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'reports', 'roco', 'coverage', 'roster-48.json'), 'utf8'));
  const rows = raw.pets ?? raw.roster ?? raw.rows ?? [];
  const names = rows.map((r) => r.name ?? r.pet_name);
  return new Set(names).size < names.length;
}

test('⑧ 结构钉：开局前必须走 battleLoadouts，不许再按名字解析配招', () => {
  assert.match(CLIENT_SRC, /battleLoadouts\(\{/, '开局前要用 battleLoadouts 过滤配招');
  assert.doesNotMatch(CLIENT_SRC, /filledSpecies/, '按名字解析的那段必须删掉（重名会静默丢配招）');
});
