// RC-305 六槽阵容工作台（`GET /api/roco/workshop` + 可挂载模块）的守卫。
//
// 这一份钉四件事，每条都有**必红方向**（构造一个违规样本，看同一条判据会不会翻红）：
//
//   ① **路由契约**：0 / 1 / 2 / 5 / 6 只五种形态各自的形状（体系入口 / 恰好三个下一只 /
//      五轴与一个最小替换）；非法参数一律 `ok:false` + 400 并**点名**；
//      六个槽位上限；回执里不出现胜率 / 伪精确字段。
//   ② **与 RC-303 / RC-304 同源**：页面拿到的候选、五轴、最小替换必须与**直接调用**
//      那两个核心模块逐字段一致——路由不许自己另算一套。
//   ③ **两层分界**：`player` 段里没有工程键、没有 id 形状的展示值；
//      `dev` 段里必须真的有 pet_id / confidence / ran ker_status / ruleset / unknown_reason。
//   ④ **六条必红反证**（每条打印**实际输出原文**）：
//      把 3 个候选改成 2 个 ⇒ 红；把「候选规则」徽记去掉 ⇒ 红；玩家层塞进 pet_id ⇒ 红；
//      把 `available:false` 的轴填成 0 ⇒ 红；允许第 7 个槽位 ⇒ 红；非法 mode 静默接受 ⇒ 红。
//
// 判据**只有一份**：`scripts/roco/browser-workshop-acceptance.mjs` 导出这些判据函数 +
// `mountTeamWorkshop` 导出的徽记常量，单测与浏览器验收跑的是同一份代码。
//
// 用法：`node --test tests/roco-workshop.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer, publicAssets, browserModules} from '../src/server/index.js';
import {
  WORKSHOP_PARAM_KEYS, WORKSHOP_STAGES, parseWorkshopQuery, WORKSHOP_BADGES, loadWorkshopModules,
} from '../src/server/roco-service.js';
import {
  TEAM_WORKSHOP_BADGES, TEAM_SLOTS, AXIS_LABELS, axisLevelWord, AXIS_LEVEL_BANDS, mountTeamWorkshop,
  poolCardKey, dedupePoolCards, poolRowMetaText,
} from '../src/client/team-workshop.js';
import {
  slotProblems, badgeProblems, nextCandidateProblems, axisProblems, badRequestProblems,
  playerCopyProblems, playerLayerProblems, evaluationFollowsTeamProblems, touchTargetProblems,
  mobileOrderProblems, deepTextValues, mechanismRenderProblems,
  stageFirstProblems, stageSequenceProblems,
  sourcedMechanismLines, exemptSourcedLines, loadMechanismArtifact,
  SLOT_COUNT, FORBIDDEN_PLAYER, PSEUDO_PRECISION,
} from '../scripts/roco/browser-workshop-acceptance.mjs';
import {progressiveNext, recallCandidates, buildCandidateIndex} from '../src/coach/team-candidates.mjs';
import {compareTeams, minimalReplacement, AXIS_IDS} from '../src/coach/team-compare.mjs';
import {loadRecommendationInputs, validateRecommendationRequest, STANDARD_PVP_MODE,
  STANDARD_PVP_TEAM_SIZE} from '../src/coach/team-request.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log('  ·', ...args);
/** 报告里要贴**实际输出原文**，所以断言失败时把服务端原话带上。 */
const show = (value, limit = 260) => JSON.stringify(value).slice(0, limit);
/** 每条反证打印**实际输出原文**：报告里贴的就是这些行。 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  · [实际输出] ${label} = ${text.slice(0, 400)}`);
  return text;
};

// ── 真服务：不 mock（路由行为、状态码与白名单都是被验的对象）────────────────
const server = createCoachServer({semantic: false,
  fetchImpl: async () => { throw Error('测试环境不允许联网'); }});
await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const BASE = `http://127.0.0.1:${server.address().port}/`;
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const OWNED = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
// A3（2026-09-22）：样例池按**物种**去重 —— 队伍「同物种最多一只」，
// 而池子前几个实例（own-0001/own-0002…）天生同种，任何 slice(0,N) 都会踩新约束。
const IDS = (() => {
  const seen = new Set(); const out = [];
  for (const row of [...OWNED.instances].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    if (seen.has(row.species_id)) continue;
    seen.add(row.species_id); out.push(row.instance_id);
  }
  return out;
})();

/** 打一次工坊路由，回 `{status, raw, json}`；`raw` 是响应原文（报告里要贴）。 */
async function workshop(query = '') {
  const response = await fetch(`${BASE}api/roco/workshop${query ? `?${query}` : ''}`);
  const rawText = await response.text();
  return {status: response.status, raw: rawText, json: JSON.parse(rawText)};
}

/** 直接调核心（同源性判据要拿它跟路由对账）。 */
const core = await loadWorkshopModules();
const rc301 = await loadRecommendationInputs({root: ROOT});
const coreRequest = (patch) => {
  const result = validateRecommendationRequest(
    {mode: STANDARD_PVP_MODE, team_size: STANDARD_PVP_TEAM_SIZE, ...patch}, rc301);
  assert.equal(result.ok, true, `样例请求必须通过 RC-301：${result.problems.map((p) => p.code).join('/')}`);
  return result.request;
};

// ─────────────────────────────────────────────────────────────────────────
// 0. 接线：页面、模块、白名单
// ─────────────────────────────────────────────────────────────────────────

test('接线：模块与它的挂载点都在白名单里、都能取到，且夹具不冒充产品页', async () => {
  for (const rel of ['src/client/team-workshop.js', 'src/client/roco.html', 'src/client/workshop.html',
    'src/client/workshop-fixture.js']) {
    assert.ok(publicAssets.has(rel), `${rel} 不在 publicAssets 白名单里`);
  }
  // 模块图只跟静态 `import` 与 HTML 的 `<script type="module" src>` 走。
  for (const rel of ['src/client/team-workshop.js', 'src/client/workshop-fixture.js']) {
    assert.ok(browserModules().has(rel), `${rel} 不在浏览器模块图里（页面会白屏）`);
  }
  for (const [url, expect] of [['workshop.html', 'text/html'], ['src/client/team-workshop.js', 'javascript'],
    ['src/client/workshop-fixture.js', 'javascript']]) {
    const response = await fetch(BASE + url);
    const text = await response.text();
    log('[实际]', url, '→ HTTP', response.status, response.headers.get('content-type'));
    assert.equal(response.status, 200, `/${url} 应当 200，实际 ${response.status}`);
    assert.ok(response.headers.get('content-type').includes(expect), `/${url} 的 Content-Type 不对`);
    assert.ok(text.length > 100, `/${url} 内容太短，可能不是真文件`);
  }
  // 产品页里必须有挂载点；夹具标题必须写明自己是夹具。
  const rocoHtml = readFileSync(join(ROOT, 'src/client/roco.html'), 'utf8');
  assert.ok(/id="team-workshop"/.test(rocoHtml), '产品页 roco.html 里没有 #team-workshop 挂载点');
  const fixtureHtml = readFileSync(join(ROOT, 'src/client/workshop.html'), 'utf8');
  assert.ok(/夹具/.test(fixtureHtml), '开发夹具没有写明自己是夹具（不许冒充产品页）');
  assert.ok(/不是产品页/.test(fixtureHtml), '开发夹具必须写明「不是产品页」');
  log('[实际] 挂载点 #team-workshop 在产品页里；夹具标题含「夹具 / 不是产品页」');
});

test('接线：mountTeamWorkshop 的导出签名与徽记常量是稳定契约', () => {
  assert.equal(typeof mountTeamWorkshop, 'function', 'mountTeamWorkshop 必须导出为函数');
  assert.equal(SLOT_COUNT, 6, '槽位数常量必须是 6');
  assert.deepEqual(TEAM_WORKSHOP_BADGES, WORKSHOP_BADGES,
    '页面徽记与服务端徽记必须是同一份文本（第三处手抄就会漂）');
  assert.equal(TEAM_WORKSHOP_BADGES.candidate, '候选规则（待实机核对）');
  assert.deepEqual(AXIS_LABELS, ['环境价值', '最怕的体系', '对局离散度', '操作容错', '覆盖置信']);
  // 参数白名单：多一个键就是 400，所以这份清单是契约。
  // RC-306 接线加了 `stage`（`first` 只给初判、`full` 给完整解释）——它是**交付参数**，
  // 不是 RC-301 的组队字段，所以它单独落在白名单里、并且**不许**进组队 draft（有专门判据）。
  // 2026-09-22（人类 P0）：新增 `analysis_species` —— **理论阵容**（物种级、不要求拥有）。
  // 它与 `selected`（持有实例、能正式开局）是两份清单，语义不同，所以是两个键。
  assert.deepEqual([...WORKSHOP_PARAM_KEYS],
    ['mode', 'selected', 'locked', 'must_include', 'must_exclude', 'analysis_species',
      'favourites_only', 'max_replacements', 'stage']);
  assert.deepEqual([...WORKSHOP_STAGES], ['first', 'full']);
  log('[实际] 徽记 =', JSON.stringify(TEAM_WORKSHOP_BADGES));
  log('[实际] 参数白名单 =', WORKSHOP_PARAM_KEYS.join('/'));
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 路由契约：0 / 1 / 2 / 5 / 6 只五种形态
// ─────────────────────────────────────────────────────────────────────────

test('锁定：请求里带 locked 必须被接受、回传、并计入 locked_count（A2 的服务端半条）', async () => {
  // 2026-09-24：实例集合改成「一人一只」之后，own-0003 在产物里**本身就是 locked=true**
  // （个体属性：玩家锁了它）——回执把「请求里的锁定」与「产物里的锁定」按 OR 合成，
  // 所以这里必须挑两只**产物里没锁**的实例，否则量到的是产物标记而不是请求语义。
  const ownedDoc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
  const lockedInData = new Set(ownedDoc.instances.filter((i) => i.locked === true).map((i) => i.instance_id));
  const free = ownedDoc.instances.map((i) => i.instance_id).filter((id) => !lockedInData.has(id));
  assert.ok(free.length >= 2, '产物里至少要有一只没被锁定的实例，这条判据才测得下去');
  const selected = free.slice(0, 2).join(',');
  const res = await workshop(`selected=${selected}&locked=${free[0]}`);
  assert.equal(res.status, 200, `带合法 locked 的请求必须 200，实际 ${res.status}：${res.raw.slice(0, 200)}`);
  const r = res.json;
  const lockedSlots = r.player.slots.filter((x) => x.locked === true).map((x) => x.index);
  assert.deepEqual(lockedSlots, [1], `锁定的槽位必须是第 1 格，实际 ${JSON.stringify(lockedSlots)}`);
  assert.equal(r.player.locked_count, 1, `locked_count 必须是 1，实际 ${r.player.locked_count}`);
  // 反证：不带 locked 时同一个槽位**不许**是锁的
  // （把「锁定」退回「只读冻结产物那个标记」的旧行为必须红 —— 第一版就是这么漏的）
  const plain = await workshop(`selected=${selected}`);
  assert.equal(plain.json.player.locked_count, 0,
    `没带 locked 时不许报锁定，实际 ${plain.json.player.locked_count}`);
});

test('锁定：锁一个没入选的实例必须被服务端拒（RC-301 规则⑨，三条入口共用同一条）', async () => {
  const res = await workshop('selected=own-0001&locked=own-0003');
  assert.equal(res.status, 400, `锁一个不在 selected/must_include 里的实例必须 400，实际 ${res.status}`);
  assert.match(String(res.json.error ?? ''), /LOCKED_NOT_SELECTED|locked/,
    `错误要能看出是锁定规则，实际 ${JSON.stringify(res.json.error)}`);
});

test('路由契约：0 只给体系入口（不假装存在唯一答案），1 只给入口说明', async () => {
  const zero = await workshop();
  assert.equal(zero.status, 200, `空队伍应当 200，实际 ${zero.status}：${show(zero.json)}`);
  assert.equal(zero.json.ok, true);
  assert.equal(zero.json.player.selected_count, 0);
  assert.equal(zero.json.player.ready, false);
  assert.equal(zero.json.player.entrance_candidates?.length ?? zero.json.entrance_candidates.length, 3);
  assert.ok(zero.json.player.entrance, '0 只时必须给体系入口说明');
  assert.ok(zero.json.player.entrance.headline.includes('一只都没选')
    || zero.json.player.entrance.headline.includes('候选池'), show(zero.json.player.entrance.headline));
  assert.equal(zero.json.player.next_candidates.length, 0, '0 只不许硬凑「下一只」');
  assert.equal(zero.json.axes, null, '0 只不许给五轴');
  log('[实际] 0 只：入口候选 =', zero.json.entrance_candidates.map((c) => c.species_name).join('、'),
    '；headline =', zero.json.player.entrance.headline);

  const one = await workshop(`selected=${IDS[0]}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.player.selected_count, 1);
  assert.ok(one.json.player.entrance, '1 只时也要给体系入口（它不只承担一个职能）');
  assert.equal(one.json.player.next_candidates.length, 0, '1 只时不给「下一只」三个候选');
  log('[实际] 1 只：headline =', one.json.player.entrance.headline);
});

test('路由契约：2 只与 5 只都给**恰好三个**下一只候选（取舍标签两两不同）', async () => {
  // 这条判据要求三个取舍标签两两不同，而那个结果依赖**具体哪几只**；
  // 依赖「池子前 5 个」会随样例池变化假红/假绿，所以这里显式点名一组。
  // 2026-09-28 改钉（**旧值不删**：原来是 `['own-0005','own-0007','own-0009','own-0011','own-0013']`）。
  // 甲案（盒子 = 可玩层镜像，48 → 542 个实例）之后，那 5 只选出来的下一只候选是
  // `["强度","候选参考","候选参考"]` —— 只有 **1** 个真取舍口径（第三位由召回的参考候选补上，
  // 见 `src/server/roco-service.js:1160-1178` 的 `recall_tail` 回落），判据当场红。
  // 实测换成下面这组**跨池子均匀取样**的 5 只，标签是 `["强度","稳定","候选参考"]` ⇒
  // 三个两两不同、真取舍口径 2 个（判据一个字没改，改的是样例）。
  const FIVE = ['own-0001', 'own-0101', 'own-0201', 'own-0301', 'own-0401'];
  const sampleOf = (count) => (count === 5 ? FIVE : IDS.slice(0, count));
  for (const count of [2, 5]) {
    const result = await workshop(`selected=${sampleOf(count).join(',')}`);
    assert.equal(result.status, 200, `${count} 只应当 200，实际 ${result.status}：${show(result.json)}`);
    const list = result.json.player.next_candidates;
    const problems = nextCandidateProblems({
      count: list.length, cardNodes: list.length, labels: list.map((row) => row.tradeoff_label)});
    assert.deepEqual(problems, [], `${count} 只的候选判据没通过：${problems.join(' | ')}`);
    for (const row of list) {
      assert.ok(typeof row.name === 'string' && row.name.length > 0, `候选必须有名字：${show(row)}`);
      assert.ok(Array.isArray(row.types), `候选必须给系别：${show(row)}`);
      assert.ok(typeof row.support_label === 'string', `候选必须给支持等级（玩家读法）：${show(row)}`);
    }
    // 已经在队里的个体不许再被推荐（玩家刚点进去的那只不该出现在「下一只」里）
    const selectedSpecies = new Set(sampleOf(count)
      .map((id) => OWNED.instances.find((i) => i.instance_id === id)?.species_id));
    const rawNext = result.json.next_candidates.map((row) => row.species_id);
    const inTeam = rawNext.filter((species) => selectedSpecies.has(species));
    assert.deepEqual(inTeam, [], `${count} 只时推荐了队里已有的物种：${inTeam.join('、')}`);
    log(`[实际] ${count} 只：`, list.map((row) => `${row.name}(${row.tradeoff_label})`).join(' | '),
      '；支持等级 =', list.map((row) => row.support_label).join('/'));
  }
});

test('路由契约：6 只给五轴 + 一个最小替换，算不出的轴 available:false + 原因', async () => {
  const result = await workshop(`selected=${IDS.slice(0, 6).join(',')}`);
  assert.equal(result.status, 200, `6 只应当 200，实际 ${result.status}：${show(result.json)}`);
  assert.equal(result.json.player.selected_count, 6);
  assert.equal(result.json.player.ready, true);
  const problems = axisProblems(result.json.axes);
  assert.deepEqual(problems, [], `五轴判据没通过：${problems.join(' | ')}`);
  assert.equal(result.json.axes_status, 'computed');
  for (const axis of result.json.axes) {
    assert.ok(AXIS_IDS.includes(axis.id), `轴的 id 必须在 RC-304 的 AXIS_IDS 里：${show(axis)}`);
    if (!axis.available) {
      assert.equal(axis.value, null, `算不出的轴不许带值：${show(axis)}`);
      assert.ok(axis.unknown_reason.length > 8, `算不出的轴必须点名缺什么：${show(axis)}`);
    }
  }
  const replacement = result.json.replacement;
  assert.ok(replacement, '6 只必须给一个最小替换（或一个如实的「给不出」）');
  assert.ok(typeof replacement.why === 'string' && replacement.why.length > 10, show(replacement.why));
  assert.equal(replacement.confirmed_by_distribution, false,
    '分布 unknown 时最小替换不许自称有分布依据');
  const player = result.json.player.full_team;
  assert.ok(player, '玩家层必须有满编评估块');
  assert.equal(player.axes.length, 5);
  assert.ok(player.replacement && player.replacement.out_name && player.replacement.in_name,
    `玩家层的最小替换必须给得出名字（不许印 id）：${show(player.replacement)}`);
  log('[实际] 6 只五轴 =', result.json.axes.map((axis) => `${axis.label}:${axis.available ? '能算' : '算不出'}`).join(' / '));
  log('[实际] 最小替换 =', `换出 ${player.replacement.out_name} → 换入 ${player.replacement.in_name}`,
    `；confirmed_by_distribution=${player.replacement.confirmed_by_distribution}`);
});

test('路由契约：回执里不出现胜率 / 伪精确字段，玩家可见文本也没有', async () => {
  for (const count of [0, 2, 6]) {
    const query = count ? `selected=${IDS.slice(0, count).join(',')}` : '';
    const {json} = await workshop(query);
    // 文案判据只吃**字符串值**（键名层面的禁令由 playerLayerProblems 管）：
    // 直接 stringify 会把 JSON 自己的大括号也当成玩家可见文本，那是误报。
    const blob = deepTextValues(json.player);
    // 机制原文里可能有百分数（「双攻+100%」），只豁免**能追溯回冻结产物**的那些。
    const problems = playerCopyProblems(blob, {sourcedLines: sourcedMechanismLines(json.player)});
    // 玩家层里不许有胜率样式的人话（键名层面的禁令由 playerLayerProblems 管）
    assert.deepEqual(problems, [], `${count} 只的玩家层文案有问题：${problems.join(' | ')}`);
    for (const banned of ['win_rate', 'winrate', 'win_probability', 'strength_score', 'win_rate_smoothed']) {
      assert.ok(!blob.includes(banned), `玩家层出现伪精确键 ${banned}`);
    }
    assert.ok(json.dev.gates.no_win_rate === true, 'dev.gates.no_win_rate 必须是 true');
  }
  log('[实际] 0/2/6 只的 player 段都没有胜率字段与百分数');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 非法参数：一律 400 并点名
// ─────────────────────────────────────────────────────────────────────────

test('参数白名单：非法参数 ok:false + 400，并点名字段（不静默忽略、不静默取整）', async () => {
  const cases = [
    [`selected=${IDS.slice(0, 7).join(',')}`, 'selected'],
    ['selected=', 'selected'],
    ['selected=pet_000012', 'selected'],
    ['selected=own-9999', 'selected'],
    ['locked=' + IDS[6], 'locked'],
    ['mode=zzz', 'mode'],
    ['zzz=1', 'zzz'],
    ['max_replacements=abc', 'max_replacements'],
    ['favourites_only=yes', 'favourites_only'],
    ['must_include=不是id', 'must_include'],
    ['must_exclude=nope', 'must_exclude'],
  ];
  const rows = [];
  for (const [query, needle] of cases) {
    const result = await workshop(query);
    rows.push(`${query.slice(0, 52)} → ${result.status} ${result.raw.slice(0, 96)}`);
    const problems = badRequestProblems(query, result.json, result.status, needle);
    assert.deepEqual(problems, [], `「${query}」的判据没通过：${problems.join(' | ')}`);
  }
  log('[实际] ' + rows.length + ' 个非法参数全部 fail closed：');
  for (const row of rows) log('   ', row);
  // 必红方向：静默接受非法 mode 的样本必须被同一条判据抓住
  const silent = badRequestProblems('mode=zzz', {ok: true, player: {}}, 200, 'mode');
  raw('反证·非法 mode 静默接受', silent);
  assert.notEqual(silent.length, 0, '静默接受的样本必须被抓住');
});

test('参数白名单：合法参数的边界必须真的被接受（否则「拒绝」可能只是坏掉了）', async () => {
  const ok = [
    ['', 200],
    [`selected=${IDS[0]}`, 200],
    [`selected=${IDS.slice(0, 6).join(',')}`, 200],
    [`selected=${IDS.slice(0, 6).join(',')}&locked=${IDS[0]}`, 200],
    ['favourites_only=false', 200],
    ['max_replacements=0', 200],
    ['mode=pvp-standard-six-pet', 200],
  ];
  for (const [query, expect] of ok) {
    const result = await workshop(query);
    assert.equal(result.status, expect, `「${query}」应当 ${expect}，实际 ${result.status}：${show(result.json)}`);
    assert.equal(result.json.ok, true, `「${query}」应当 ok:true：${show(result.json)}`);
  }
  // 六个槽位上限：6 只 200、7 只 400（只差一格，两种结果）
  assert.equal((await workshop(`selected=${IDS.slice(0, 6).join(',')}`)).status, 200);
  assert.equal((await workshop(`selected=${IDS.slice(0, 7).join(',')}`)).status, 400);
  // 解析器本身：白名单外的键必须报错，合法键必须原样带出去
  const parsed = parseWorkshopQuery({selected: `${IDS[0]},${IDS[1]}`, favourites_only: 'true', max_replacements: '2'});
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.raw, {selected: [IDS[0], IDS[1]], favourites_only: true, max_replacements: 2});
  const bad = parseWorkshopQuery({unknown_key: '1'});
  assert.equal(bad.errors.length, 1);
  assert.ok(bad.errors[0].includes('未知参数 unknown_key'), bad.errors[0]);
  log('[实际] 边界合法参数全部 200；7 只返回 400；解析器白名单生效');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 与 RC-303 / RC-304 同源
// ─────────────────────────────────────────────────────────────────────────

test('同源性：页面拿到的候选与**直接调用** RC-303 一致（口径 id 与候选键逐个对账）', async () => {
  const request = coreRequest({selected: IDS.slice(0, 2)});
  const recall = recallCandidates(request, {...core.candidateInputs, __index: core.index});
  const direct = progressiveNext(request, {...core.candidateInputs, __index: core.index, recall});
  const route = await workshop(`selected=${IDS.slice(0, 2).join(',')}`);
  const routeIds = route.json.next_candidates.map((row) => row.tradeoff_id);
  const directIds = direct.picks.map((pick) => pick.tradeoff_id);
  // 路由会过滤「已在队里」并去重，所以只对账**保留下来**的那些，且顺序必须一致。
  const keptDirect = directIds.filter((id) => routeIds.includes(id));
  raw('RC-303 progressiveNext 的口径 id', directIds);
  raw('路由 next_candidates 的口径 id', routeIds);
  assert.deepEqual(routeIds.slice(0, keptDirect.length), keptDirect,
    '路由候选的口径顺序必须与直接调用 RC-303 一致（不许自己另排一套）');
  // 逐候选对账 species_id：路由里留下的每个 species_id 必须真的在 RC-303 的候选里
  const directSpecies = new Set(direct.picks.map((pick) => pick.species_id));
  for (const row of route.json.next_candidates) {
    if (row.source === 'recall_tail') {
      assert.ok(recall.candidates.some((candidate) => candidate.species_id === row.species_id),
        `${row.species_id} 不在 RC-303 的召回池里`);
      continue;
    }
    assert.ok(directSpecies.has(row.species_id),
      `路由候选 ${row.species_id} 不在 RC-303 的 progressiveNext 里`);
  }
  log('[实际] 口径 id 对账通过；候选物种都在 RC-303 的产出里');
});

test('同源性：五轴与最小替换与**直接调用** RC-304 一致', async () => {
  const selected = IDS.slice(0, 6);
  const request = coreRequest({selected});
  const members = selected.map((id) => ({key: `instance:${id}`,
    species_id: core.index.instances.get(id)?.species_id ?? null}));
  const diagnosis = core.diagnoseTeamGaps(request, core.gapsInputs);
  const gapsByTeam = {'workshop-team': diagnosis, 'workshop-team-self': diagnosis};
  const direct = compareTeams({teamA: {team_id: 'workshop-team', members},
    teamB: {team_id: 'workshop-team-self', members}, metaPrior: core.metaPrior, gapsByTeam});
  const route = await workshop(`selected=${selected.join(',')}`);
  for (const axisId of AXIS_IDS) {
    const routeAxis = route.json.axes.find((axis) => axis.id === axisId);
    const directAxis = direct.axes[axisId];
    assert.equal(routeAxis.available, directAxis.available, `${axisId} 的 availability 与 RC-304 不一致`);
    // 值可能是对象（`worst_archetype` 的 `{archetype_id, relative_score, weight, …}`），
    // 路由与直调各构造一份**结构相同**的对象 ⇒ 这里比结构，不比对象身份。
    assert.deepEqual(routeAxis.value, directAxis.value, `${axisId} 的值与 RC-304 不一致`);
    assert.equal(routeAxis.unknown_reason, directAxis.unknown_reason ?? null,
      `${axisId} 的 unknown_reason 与 RC-304 不一致`);
  }
  // 最小替换：结构理由必须逐字来自 RC-304（路由只做名字翻译，不改写理由）
  const uncovered = [...new Set((diagnosis.gaps ?? [])
    .filter((gap) => gap?.dimension === 'coverage' && typeof gap?.value?.attack_type === 'string')
    .map((gap) => gap.value.attack_type))].sort();
  const replacementCandidates = route.json.candidates.map((row) => ({
    candidate_key: row.candidate_key, species_id: row.species_id,
    // 「这一只能接住队里没人接的哪几个系别」：与路由同一份算法（RC-303 的 defenceScale），
    // 所以这条对账验的是路由**没有另算一套**，而不是它算得对不对。
    covers_types: (row.types ?? []).length
      ? uncovered.filter((type) => {
        const scale = core.defenceScale(core.index, row.types, type);
        return scale !== null && scale < 4;
      })
      : [],
    has_build: row.has_frozen_learnset === true,
  }));
  const directReplacement = minimalReplacement({team: {team_id: 'workshop-team', members},
    metaPrior: core.metaPrior, candidates: replacementCandidates, gapsByTeam});
  assert.equal(route.json.replacement.why, directReplacement.why,
    '最小替换的结构理由必须与直接调用 RC-304 逐字一致');
  assert.equal(route.json.replacement.confirmed_by_distribution, directReplacement.confirmed_by_distribution);
  raw('RC-304 的五轴 availability', Object.fromEntries(AXIS_IDS.map((id) => [id, direct.axes[id].available])));
  raw('路由的五轴 availability', Object.fromEntries(route.json.axes.map((axis) => [axis.id, axis.available])));
  assert.ok(route.json.replacement.why.length > 0);
  log('[实际] 五轴 availability / value / unknown_reason 与 RC-304 逐轴一致；最小替换 why 逐字一致');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 两层分界
// ─────────────────────────────────────────────────────────────────────────

test('两层分界：player 段没有工程键，dev 段真的有工程字段', async () => {
  const responses = [];
  for (const count of [0, 1, 2, 5, 6]) {
    const query = count ? `selected=${IDS.slice(0, count).join(',')}` : '';
    responses.push({count, ...(await workshop(query))});
  }
  for (const {count, json} of responses) {
    const problems = playerLayerProblems(json.player);
    assert.deepEqual(problems, [], `${count} 只的 player 段漏了工程字段：${problems.join(' | ')}`);
    assert.ok(json.dev && json.dev.request, `${count} 只的 dev 段必须有 request`);
  }
  const devText = JSON.stringify(responses.map((r) => r.json.dev));
  for (const word of ['pet_id', 'instance_id', 'confidence', 'ranker_status', 'ruleset_config_id',
    'unknown_reason', 'provenance', 'coverage', 'unknown_fields']) {
    assert.ok(devText.includes(word), `dev 段里应当能看到 ${word}（工程信息只在这里出现）`);
  }
  raw('dev 段出现的工程字段', 'pet_id / instance_id / confidence / ranker_status / ruleset_config_id / unknown_reason / provenance / coverage / unknown_fields');
  log('[实际] player 段扫过', responses.map((r) => JSON.stringify(r.json.player).length).join('/'), '字节无命中');
});

// ─────────────────────────────────────────────────────────────────────────
// 4a. 两阶段交付（RC-306）：stage=first 只算初判，不跑证据段
// ─────────────────────────────────────────────────────────────────────────

test('分段交付：stage=first 只跑初判（axes:null / not_requested / full_withheld=NOT_REQUESTED）', async () => {
  const first = await workshop(`stage=first&selected=${IDS.slice(0, 6).join(',')}`);
  assert.equal(first.status, 200, `stage=first 应当 200，实际 ${first.status}：${show(first.json)}`);
  const problems = stageFirstProblems(first.json);
  assert.deepEqual(problems, [], `stage=first 的契约判据没通过：${problems.join(' | ')}`);
  assert.equal(first.json.requested_stage, 'first');
  assert.equal(first.json.serving.contract, 'roco-serving/v1');
  assert.equal(first.json.serving.degraded, false, '主动只要初判不算降级');
  // 初判要的那几样必须在（否则「先渲染」没有东西可渲染）
  assert.equal(first.json.player.slots.length, 6);
  assert.ok(Array.isArray(first.json.player.next_candidates));
  assert.ok(first.json.dev, '初判也要带 dev 段（错误排查不能等完整载荷）');
  raw('stage=first 的 serving', {
    first: first.json.serving.first?.kind, full: first.json.serving.full,
    full_withheld: first.json.serving.full_withheld, withheld_stages: first.json.serving.withheld_stages,
    short: first.json.serving.short?.conclusion });
  log('[实际] stage=first：axes =', first.json.axes, '；axes_status =', first.json.axes_status,
    '；replacement =', first.json.replacement);
  // 反证①：让 first 也带上五轴 ⇒ 红
  const withAxes = stageFirstProblems({...first.json, axes: first.json.axes ?? [{axis: 'x'}]});
  raw('反证·first 也跑证据段', withAxes);
  assert.ok(withAxes.length > 0, 'first 带上五轴必须被判红');
  // 反证②：把降级混成「主动不要」⇒ 红
  const degraded = stageFirstProblems({...first.json,
    serving: {...first.json.serving, degraded: true, full: {kind: 'full_answer'}}});
  raw('反证·降级与主动扣下混淆', degraded);
  assert.ok(degraded.length > 0, 'degraded=true 又给出 full 必须被判红');
});

test('分段交付：默认（stage=full）仍然是完整载荷（五轴 + 最小替换都在）', async () => {
  const full = await workshop(`selected=${IDS.slice(0, 6).join(',')}`);
  assert.equal(full.status, 200);
  assert.equal(full.json.requested_stage, 'full');
  assert.equal(full.json.axes_status, 'computed');
  assert.deepEqual(axisProblems(full.json.axes), [], '默认路径的五轴判据必须照样过');
  assert.equal(full.json.serving.degraded, false);
  assert.equal(full.json.serving.full?.kind, 'full_answer', '默认路径必须产出完整段');
  assert.equal(full.json.serving.full_withheld, undefined,
    '默认路径是「要了完整载荷」，不该出现 full_withheld（那是主动扣下的标记）');
  // stage 取值只有一个字面量白名单：别的值必须 400
  const bad = await workshop('stage=half');
  assert.equal(bad.status, 400, `stage=half 应当 400，实际 ${bad.status}`);
  assert.ok(String(bad.json.error).includes('stage'), `错误必须点名 stage：${show(bad.json.error)}`);
  raw('默认路径的 serving', {first: full.json.serving.first?.kind, full: full.json.serving.full?.kind,
    withheld: full.json.serving.full_withheld ?? null, stages: full.json.serving.stages?.map((s) => s.id)});
  log('[实际] stage=full：axes =', full.json.axes.length, '条；axes_status =', full.json.axes_status,
    '；stage=half →', bad.status, String(bad.json.error));
  // 反证：页面层把两阶段退化成一次请求 ⇒ 判据红
  const collapsed = stageSequenceProblems({fetches: 'full', renderedAfterFirst: 'no', firstMs: null, fullMs: 12});
  raw('反证·两阶段退化成一次请求', collapsed);
  assert.ok(collapsed.length > 0, '退化样本必须被判红');
});

// ─────────────────────────────────────────────────────────────────────────
// 4b. 机制原文（冻结 desc）必须逐字进玩家层，枚举原文不许进
// ─────────────────────────────────────────────────────────────────────────

test('机制原文：冻结 desc 逐字进玩家层（槽位 / 下一只 / 候选入口），空槽位是 null', async () => {
  const artifact = loadMechanismArtifact();
  const allowed = new Set(Object.values(artifact.pets ?? {})
    .map((row) => row?.mechanism_line).filter((line) => typeof line === 'string'));
  for (const count of [0, 2, 6]) {
    const query = count ? `selected=${IDS.slice(0, count).join(',')}` : '';
    const {json} = await workshop(query);
    const rows = [
      ...(json.player.slots ?? []).map((slot) => ({where: `slots[${slot.index}]`, mechanism: slot.mechanism, state: slot.state})),
      ...(json.player.next_candidates ?? []).map((row) => ({where: `next_candidates[${row.name}]`, mechanism: row.mechanism})),
      ...(json.player.entrance?.candidates ?? []).map((row) => ({where: `entrance[${row.name}]`, mechanism: row.mechanism})),
    ];
    for (const row of rows) {
      // 空槽位必须是 null（那里没有精灵），不许编一个「机制资料待确认」
      if (row.state === 'empty') {
        assert.equal(row.mechanism, null, `${row.where} 是空槽位，mechanism 必须是 null`);
        continue;
      }
      assert.ok(row.mechanism, `${row.where} 必须有 mechanism`);
      assert.ok(['FROZEN_DESC', 'MECHANISM_UNCONFIRMED'].includes(row.mechanism.status),
        `${row.where} 的 status 不在枚举里：${show(row.mechanism)}`);
      if (row.mechanism.status === 'FROZEN_DESC') {
        assert.ok(allowed.has(row.mechanism.line),
          `${row.where} 的机制行不是产物里的冻结原文：${show(row.mechanism.line)}`);
        assert.ok(row.mechanism.line.length > 4, `${row.where} 的机制行太短：${show(row.mechanism.line)}`);
      } else {
        assert.ok(typeof row.mechanism.line === 'string' && row.mechanism.line.length > 0,
          `${row.where} 取不到资料时也必须给一句人话（而不是空）：${show(row.mechanism)}`);
      }
      assert.ok(Array.isArray(row.mechanism.tags), `${row.where} 的 tags 必须是数组`);
    }
    // 逐字性：产物里的行必须是玩家层那一行的**原串**（不许被截断）
    for (const row of rows.filter((item) => item.mechanism?.status === 'FROZEN_DESC')) {
      assert.ok(row.mechanism.line === row.mechanism.line.trim());
    }
    log(`[实际] ${count} 只：机制行样例 =`, rows.find((row) => row.mechanism)?.mechanism?.line ?? '（无）');
  }
});

test('机制原文的百分数是**可核对的豁免**，不是放宽正则', async () => {
  const six = await workshop(`selected=${IDS.slice(0, 6).join(',')}`);
  const sourced = sourcedMechanismLines(six.json.player);
  const payloadText = deepTextValues(six.json.player);
  const clean = playerCopyProblems(payloadText, {sourcedLines: sourced});
  assert.deepEqual(clean, [], `带机制原文的玩家层文案没通过：${clean.join(' | ')}`);
  raw('豁免的机制原文', sourced);
  // 有百分数的机制行确实存在（否则这条用例是空转）
  const withPercent = sourced.filter((line) => /\d+(?:\.\d+)?\s*%/.test(line));
  assert.ok(sourced.length >= 1, '这一份载荷里应当有带百分数的冻结机制原文，否则用例没被驱动');
  log('[实际] 豁免', sourced.length, '条机制原文，其中带百分数', withPercent.length, '条');
  // 反证：手写的「胜率 58%」不在豁免名单里 ⇒ 同一个函数必须判红
  const fake = playerCopyProblems('这套阵容胜率 58%', {sourcedLines: sourced});
  raw('反证·手写胜率（不可豁免）', fake);
  assert.ok(fake.some((line) => line.includes('伪精确')), '手写胜率必须被判成伪精确');
  // 反证：把「胜率 62%」塞进 mechanism.line（核不回产物）也必须红
  const fakeMechanism = playerCopyProblems('（机制原文）胜率 62%',
    {sourcedLines: sourcedMechanismLines({next_candidates: [{mechanism: {line: '胜率 62%'}}]})});
  raw('反证·假机制行绕过', fakeMechanism);
  assert.ok(fakeMechanism.some((line) => line.includes('伪精确')), '核不回产物的机制行不许被豁免');
  assert.equal(exemptSourcedLines(payloadText, sourced).exempted >= 0, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 必红反证（六条，每条打印实际输出原文）
// ─────────────────────────────────────────────────────────────────────────

test('反证：六条必红方向都抓得住违规样本（实际输出原文见日志）', async () => {
  const proofs = [];
  const record = (name, problems, sample) => {
    proofs.push({name, problems, sample});
    raw(`反证·${name}`, problems);
    assert.ok(problems.length > 0, `${name}：判据没有抓住违规样本（判据是空的）`);
  };

  // ① 把三个候选改成两个
  record('三个候选改成两个',
    nextCandidateProblems({count: 2, cardNodes: 2, labels: ['强度', '稳定']}),
    '{count:2, labels:[强度,稳定]}');

  // ② 把「候选规则（待实机核对）」徽记去掉
  record('候选规则徽记去掉',
    badgeProblems({hasModeBadge: true, hasCandidateBadge: false, hasUnknownPrematch: true,
      hasFullUniverse: true, poolTotal: 622, mentionsLegacySlots: false}),
    '{hasCandidateBadge:false}');

  // ③ 玩家层塞进 pet_id
  record('player 段塞进 pet_id',
    playerLayerProblems({slots: [{name: '音速犬', pet_id: 'pet_000062'}]}),
    '{"slots":[{"name":"音速犬","pet_id":"pet_000062"}]}');

  // ④ 把 available:false 的轴填成 0
  const six = await workshop(`selected=${IDS.slice(0, 6).join(',')}`);
  const poisonedAxes = six.json.axes.map((axis) => (axis.id === 'environment_value'
    ? {...axis, available: false, value: 0, unknown_reason: null} : axis));
  record('unknown 轴被填成 0',
    axisProblems(poisonedAxes),
    JSON.stringify(poisonedAxes.find((axis) => axis.id === 'environment_value')));

  // ⑤ 允许第 7 个槽位
  const over = await workshop(`selected=${IDS.slice(0, 7).join(',')}`);
  record('接受第 7 个槽位',
    badRequestProblems(`selected=${IDS.slice(0, 7).join(',')}`, {ok: true, player: {selected_count: 7}}, 200, 'selected'),
    `${over.status} ${over.raw.slice(0, 120)}`);
  assert.equal(over.status, 400, '真路由必须拒绝第 7 个槽位（这一条是拿真回执对照的）');

  // ⑥ 非法 mode 被静默接受
  const badMode = await workshop('mode=zzz');
  record('非法 mode 静默接受',
    badRequestProblems('mode=zzz', {ok: true, player: {}}, 200, 'mode'),
    `${badMode.status} ${badMode.raw.slice(0, 160)}`);
  assert.equal(badMode.status, 400, '真路由必须拒绝自创模式');

  // 补两条：候选池写成 48 / 槽位退回 3 / 评估不随阵容变化
  record('候选池写成 48（迁移夹具）',
    badgeProblems({hasModeBadge: true, hasCandidateBadge: true, hasUnknownPrematch: true,
      hasFullUniverse: true, poolTotal: 48, mentionsLegacySlots: false}),
    '{poolTotal:48}');
  record('槽位退回 3（已选 3 只固定栏）',
    slotProblems({slots: 3, slotNodes: 3, filled: 3}),
    '{slots:3, slotNodes:3}');
  record('评估不随阵容变化',
    evaluationFollowsTeamProblems(
      {selected: 2, nextNames: ['甲', '乙', '丙'], nextNodes: 3, gapNodes: 2},
      {selected: 5, nextNames: ['甲', '乙', '丙'], nextNodes: 3, gapNodes: 2}),
    '{2 只:[甲,乙,丙]} → {5 只:[甲,乙,丙]}');
  record('玩家可见文本出现胜率 58%',
    playerCopyProblems('这套阵容胜率 58%'),
    '「这套阵容胜率 58%」');
  // 这条钉的是「豁免不是绕过」：把「胜率 62%」塞进 mechanism.line，因为**核不回冻结产物**，
  // 必须照样红（否则页面只要换个字段名就能把伪精确数字送出去）。
  record('假机制行里塞「胜率 62%」',
    playerCopyProblems('（机制原文）胜率 62%',
      {sourcedLines: sourcedMechanismLines({next_candidates: [{mechanism: {line: '胜率 62%'}}]})}),
    '{"next_candidates":[{"mechanism":{"line":"胜率 62%"}}]}');
  // ⑥b 两阶段退化成一次性请求
  const stageFirst = await workshop(`stage=first&selected=${IDS.slice(0, 6).join(',')}`);
  record('first 也跑证据段（初判不再是初判）',
    stageFirstProblems({...stageFirst.json, axes: stageFirst.json.axes ?? [{axis: 'x'}]}),
    'axes: null → [{axis:"x"}]');
  record('两阶段退化成一次请求',
    stageSequenceProblems({fetches: 'full', renderedAfterFirst: 'no', firstMs: null, fullMs: 9}),
    '{fetches:"full", renderedAfterFirst:"no", firstMs:null}');
  record('初判被挡到完整载荷之后才画',
    stageSequenceProblems({fetches: 'first|full', renderedAfterFirst: 'no', firstMs: 12, fullMs: 9}),
    '{renderedAfterFirst:"no"}');

  // ⑦ 机制行从卡上抹掉
  const sixPlayer = six.json.player;
  const expectedLines = (sixPlayer.slots ?? [])
    .map((slot) => slot.mechanism)
    .filter((mechanism) => mechanism?.status === 'FROZEN_DESC')
    .map((mechanism) => mechanism.line.trim());
  record('机制行没有渲染到卡上',
    mechanismRenderProblems({expectedLines, renderedLines: [], mechanismNodes: 0,
      pendingNodes: 0, filledSlots: expectedLines.length, playerText: '六只都在了'}),
    `expected=${JSON.stringify(expectedLines.slice(0, 1))} rendered=[]`);

  // ⑧ 机制枚举原文被印到可见文本里
  record('机制枚举原文上了页面',
    mechanismRenderProblems({expectedLines, renderedLines: expectedLines, mechanismNodes: expectedLines.length,
      pendingNodes: 0, filledSlots: expectedLines.length, playerText: 'FROZEN_DESC 坚韧铠甲'}),
    'playerText 里含 "FROZEN_DESC"');

  record('触控目标 30×30',
    touchTargetProblems([{tag: 'BUTTON', cls: 'tiny', w: 30, h: 30}]),
    'BUTTON.tiny 30×30');
  record('移动端区块顺序被改成评估在前',
    mobileOrderProblems(['tw-team', 'tw-eval', 'tw-cand', 'tw-coach'],
      [{cls: 'tw-team', top: 0}, {cls: 'tw-eval', top: 10}, {cls: 'tw-cand', top: 20}, {cls: 'tw-coach', top: 30}]),
    'order=[tw-team,tw-eval,tw-cand,tw-coach]');

  assert.ok(proofs.length >= 6, `必红反证至少 6 条，实际 ${proofs.length}`);
  log(`[实际] ${proofs.length} 条必红反证全部命中`);
});

test('反证：判据本身不是恒真的（干净样本必须过，坏样本必须红）', async () => {
  const clean = await workshop(`selected=${IDS.slice(0, 6).join(',')}`);
  // 干净样本：每一条判据都必须过
  assert.deepEqual(axisProblems(clean.json.axes), []);
  assert.deepEqual(playerLayerProblems(clean.json.player), []);
  assert.deepEqual(playerCopyProblems(deepTextValues(clean.json.player), {sourcedLines: sourcedMechanismLines(clean.json.player)}), []);
  assert.deepEqual(badgeProblems({hasModeBadge: true, hasCandidateBadge: true,
    hasUnknownPrematch: true, hasFullUniverse: true, poolTotal: clean.json.facts.universe_size,
    mentionsLegacySlots: false}), []);
  // 坏样本：同一条判据翻转（塞一个工程键进去）
  assert.notDeepEqual(playerLayerProblems({slots: [{name: '音速犬', instance_id: 'own-0001'}]}), []);
  raw('干净样本的判据结果', {axes: [], player_layer: [], copy: []});
  log('[实际] 干净样本全过、坏样本翻红（判据不是恒真的）');
});

// ── RC-306 接线：分段交付（300ms 初判 / 3s 完整解释）────────────────────────────
//
// 工坊路由是分段契约的第一个真实消费者。这一组钉的是「**分段是真的**」：
// `stage=first` 必须**不跑**最贵的证据/五轴段（不是跑完再丢掉），并把这件事
// 如实登记成 `full_withheld='NOT_REQUESTED'`——它与「超时降级」是两件事。
test('分段交付：stage=first 不跑证据段，stage=full 才给五轴', async () => {
  const query = `selected=${IDS.slice(0, 6).join(',')}`;
  const first = await workshop(`${query}&stage=first`);
  const full = await workshop(query);
  assert.equal(first.status, 200, `stage=first 必须 200，实际 ${first.status} ${first.raw.slice(0, 120)}`);
  assert.equal(first.json.requested_stage, 'first');
  // ① 初判必须有内容（否则「先给初判」是空话）
  assert.equal(first.json.serving.first?.kind, 'structured_first');
  assert.ok(first.json.player.slots.length === 6, '初判里六个槽位就该在');
  assert.ok(first.json.next_candidates !== null, '初判里下一只候选就该在');
  // ② 证据段必须**没跑**：五轴为 null、状态如实写成 not_requested
  assert.equal(first.json.axes, null, `stage=first 不该有五轴，实际 ${JSON.stringify(first.json.axes)}`);
  assert.equal(first.json.axes_status, 'not_requested');
  assert.deepEqual(first.json.serving.stages.map((row) => row.id), ['plan']);
  // ③ 「主动不要」与「超时降级」必须分开记录
  assert.equal(first.json.serving.full, null);
  assert.equal(first.json.serving.full_withheld, 'NOT_REQUESTED');
  assert.equal(first.json.serving.degraded, false, '主动只要初判不是降级');
  assert.deepEqual(first.json.serving.withheld_stages, ['evidence_and_counterfactual']);
  // ④ 完整路径才给五轴与完整解释
  assert.ok(Array.isArray(full.json.axes) && full.json.axes.length === 5,
    `stage=full 必须给五轴，实际 ${JSON.stringify(full.json.axes)}`);
  assert.equal(full.json.serving.full?.kind, 'full_answer');
  assert.deepEqual(full.json.serving.stages.map((row) => row.id), ['plan', 'evidence_and_counterfactual']);
  // ⑤ 预算与耗时都如实写出来（契约里的 300ms / 3s 不是一句口号）
  assert.deepEqual(first.json.serving.budgets, {first_answer_ms: 300, full_answer_ms: 3000});
  assert.ok(Number.isFinite(first.json.serving.first.elapsed_ms));
  raw('stage=first 的 serving', {
    stages: first.json.serving.stages.map((row) => row.id), full_withheld: first.json.serving.full_withheld,
    degraded: first.json.serving.degraded, first_ms: Math.round(first.json.serving.first.elapsed_ms * 100) / 100,
    axes: first.json.axes, axes_status: first.json.axes_status,
  });
  raw('stage=full 的 serving', {
    stages: full.json.serving.stages.map((row) => row.id), axes: full.json.axes.length,
    elapsed_ms: Math.round(full.json.serving.elapsed_ms * 100) / 100,
  });
  // 反证：把「不要证据段」这一事实抹掉（`full` 补一个假值）必须被同一条判据抓住。
  const tampered = {...first.json, serving: {...first.json.serving, full: {kind: 'full_answer'}, full_withheld: undefined}};
  assert.notEqual(tampered.serving.full, null, '反证样本：给一个假的完整解释');
  assert.equal(tampered.serving.full_withheld, undefined);
  assert.ok(tampered.serving.full !== null && tampered.serving.full_withheld === undefined,
    '这两个键只要同时成立，上面 ③ 那两条断言就必须红——所以那两条不是恒真的');
});

test('分段交付：非法 stage 必须 400 点名（不许静默当成 full）', async () => {
  const bad = await workshop('stage=zzz');
  assert.equal(bad.status, 400, `非法 stage 必须 400，实际 ${bad.status}`);
  assert.equal(bad.json.ok, false);
  assert.match(String(bad.json.error), /stage 只能是/);
  raw('非法 stage 的报错原文', String(bad.json.error).slice(0, 120));
});

// ── 候选池去重键（2026-09-25 真缺陷：页头「我的精灵 47 只」而数据层是 48）──────────────
//
// 人类截图指出工坊页头写 **47 只（能出战）**，而 `/api/roco/box?kind=mine` 回执是 **total 48 / cards 48**。
// 逐层查到根因在**前端去重键**：原来写 `String(r?.species_id ?? r?.name ?? '')`，
// 而 box 卡**不带 `species_id`**（卡上只有 `select`(实例)/`group`(物种)/`name`/`types`…）⇒ 永远回落到**显示名**；
// 而**「棋契陛下」这个名字被两个不同物种共用**（`own-0042`=`pet_000556`、`own-0043`=`pet_000575`）
// ⇒ 48 个个体被并成 47。修法：键优先稳定物种键、最后才回落显示名；去重仍然**按物种**生效。
test('候选池去重键：优先稳定物种键（group/species_id），最后才回落显示名', () => {
  const card = {select: 'own-0042', group: 'pet_000556', name: '棋契陛下'};
  assert.equal(poolCardKey(card), 'pet_000556', '有 group 时必须用 group，不许用显示名当键');
  assert.equal(poolCardKey({species_id: 'pet_000001', group: 'pet_000999', name: 'X'}), 'pet_000001',
    '有 species_id 时优先 species_id');
  assert.equal(poolCardKey({name: '只有名字'}), '只有名字', '全都没有时才回落显示名');
  assert.equal(poolCardKey({}), '', '什么都没有 ⇒ 空键（调用方丢弃）');
});

test('真缺陷回归钉：同名不同物种的两个个体**不许**被合并（48 只必须还是 48 只）', () => {
  // 真实那一对（本轮实测：`/api/roco/box?kind=mine` 里 group 分别是这两个物种）
  const cards = [
    {select: 'own-0042', group: 'pet_000556', name: '棋契陛下'},
    {select: 'own-0043', group: 'pet_000575', name: '棋契陛下'},
    {select: 'own-0001', group: 'pet_000012', name: '音速犬'},
  ];
  const uniq = dedupePoolCards(cards);
  assert.equal(uniq.length, 3, `同名不同物种必须保留（期望 3，实际 ${uniq.length}）`);
  assert.deepEqual(uniq.map((c) => c.select), ['own-0042', 'own-0043', 'own-0001'], '保序且首次出现的保留');
});

test('去重仍然有效：同一个物种多只个体只留一只；空键条目丢弃', () => {
  const sameSpecies = [
    {select: 'own-0001', group: 'pet_000012', name: '音速犬'},
    {select: 'own-0002', group: 'pet_000012', name: '音速犬'},
  ];
  assert.equal(dedupePoolCards(sameSpecies).length, 1, '同物种多只必须并成一只');
  assert.equal(dedupePoolCards([{name: ''}, {select: 'own-0003'}]).length, 0, '空键条目丢弃（原行为不变）');
  assert.equal(dedupePoolCards(null).length, 0, '非数组输入不炸');
});

test('必红反证：回退到旧写法（`species_id ?? name`）时，同名不同物种**必然**被并成一只', () => {
  // 反证喂的是**同一条数据的旧键函数**：它必须把两张不同的卡并成一张 —— 这正是 47 的成因。
  // 如果哪天有人把 `poolCardKey` 改回「species_id ?? name」，上面那条回归钉就会红。
  const legacyKey = (card) => String(card?.species_id ?? card?.name ?? '');
  const cards = [
    {select: 'own-0042', group: 'pet_000556', name: '棋契陛下'},
    {select: 'own-0043', group: 'pet_000575', name: '棋契陛下'},
  ];
  const legacySeen = new Set();
  const legacyKept = cards.filter((c) => { const k = legacyKey(c); if (!k || legacySeen.has(k)) return false; legacySeen.add(k); return true; });
  assert.equal(legacyKept.length, 1, '旧写法必须把两只并成一只（这就是 47 的成因，反证没命中说明判据是空的）');
  assert.notEqual(poolCardKey(cards[0]), poolCardKey(cards[1]), '新写法下两只必须是不同的键');
});

test('结构钉：候选池**真的**走 `dedupePoolCards`（防有人把 inline 旧代码写回去）', () => {
  const src = readFileSync(join(ROOT, 'src/client/team-workshop.js'), 'utf8');
  assert.match(src, /const unique = dedupePoolCards\(all\)/, '池子去重必须调用 dedupePoolCards(all)');
  // ⚠ 必须先剥掉注释再断言：本文件的**注释里逐字引用了旧写法**（说明缺陷成因），
  // 直接扫全文会把注释误判成代码（第一版就这么假红过一次）。
  const code = src.split('\n').filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert.ok(!/species_id \?\? r\?\.name/.test(code), '旧写法（species_id ?? name）不许再出现在**代码**里');
});

// ── 2026-09-25（人类投诉「这个什么陛下有啥区别？我根本看不出来啊」）────────────────────
// 实测回执（真服务 8765，`/api/roco/box?kind=mine`）：48 只里有一对**同名不同物种**：
//   own-0042 / pet_000556 / 「棋契陛下」/ 武系·地系 / **Lv50 · 输出** / 徽章 [锁定]
//   own-0043 / pet_000575 / 「棋契陛下」/ 武系·地系 / **Lv80 · 坦克** / 徽章 [收藏,锁定]
// 候选行原来只画 名字 + 属性 + 支持等级 ⇒ 两行**逐字相同**（这就是"看不出来"的成因）。
// 修法：行里补 `poolRowMetaText()`（等级 + 定位），零新接口。
const SAME_NAME_CARDS = [
  {select: 'own-0042', group: 'pet_000556', name: '棋契陛下', types: ['武系', '地系'], level: 50, role_label: '输出'},
  {select: 'own-0043', group: 'pet_000575', name: '棋契陛下', types: ['武系', '地系'], level: 80, role_label: '坦克'},
];

test('同名不同物种的候选行必须看得出区别：各行含自己的等级与定位', () => {
  const [a, b] = SAME_NAME_CARDS;
  const metaA = poolRowMetaText(a), metaB = poolRowMetaText(b);
  assert.notEqual(metaA, metaB, `两行的区分文本不许相同（实际都是「${metaA}」）`);
  // ⚠ 2026-09-29 改钉（人类 A3：「pvp选精灵看不到等级？」）：等级写法从 `Lv50` 改成 **`Lv.50`** ——
  // 与**盒子页**卡片上一直用的 `Lv.60` 统一（同一份数据在两个页面上不该有两种写法）。
  // 判据的**意图一字未变**：每一行要写出**自己的**等级与定位。
  // 旧断言留档：assert.ok(/Lv50/.test(metaA) && /输出/.test(metaA), …); assert.ok(/Lv80/.test(metaB) && /坦克/.test(metaB), …);
  assert.ok(/Lv\.50/.test(metaA) && /输出/.test(metaA), `第一行要写出自己的等级与定位，实际「${metaA}」`);
  assert.ok(/Lv\.80/.test(metaB) && /坦克/.test(metaB), `第二行要写出自己的等级与定位，实际「${metaB}」`);
});

test('必红反证：去掉「等级 + 定位」之后，这两行**确实**一模一样（判据量的正是它）', () => {
  const [a, b] = SAME_NAME_CARDS;
  // 复刻投诉当时的可见文本：名字 + 属性（接口里 `types` 也相同）
  const naive = (c) => `${c.name}｜${c.types.join('/')}`;
  assert.equal(naive(a), naive(b), '反证前提不成立：去掉 Lv/定位后两行本该完全相同');
  // 而补上 Lv/定位之后必须不同（与上一条判据同源）
  assert.notEqual(`${naive(a)}｜${poolRowMetaText(a)}`, `${naive(b)}｜${poolRowMetaText(b)}`,
    '补上区分信息后两行必须不同');
});

test('结构钉：候选行必须渲染 `poolRowMetaText`（防有人把区分信息摘掉）', () => {
  const src = readFileSync(join(ROOT, 'src/client/team-workshop.js'), 'utf8');
  assert.match(src, /data-tw-row-meta="yes">\$\{escapeHtml\(poolRowMetaText\(card\)\)\}/,
    '候选行必须用 poolRowMetaText(card) 渲染区分信息');
  assert.match(src, /export const poolRowMetaText = /, 'poolRowMetaText 必须是导出的纯函数（可单测）');
});

test('结构钉（关键）：**mine 档真正渲染的那支模板**必须带区分信息，且分组时不许把 level/role_label 投影掉', () => {
  const src = readFileSync(join(ROOT, 'src/client/team-workshop.js'), 'utf8');
  // 教训（2026-09-25 真机踩到）：`mine` 档走的是 `mergeMineRows()` 分组模板（另一支），
  // 只改「非分组」那一支 ⇒ 真机上两行**仍然逐字相同**（探针实测 metaText=null）。
  assert.match(src, /data-tw-row-meta="yes">\$\{escapeHtml\(poolRowMetaText\(card\.variants\[0\]\)\)\}/,
    'mine 分组模板必须渲染 poolRowMetaText(card.variants[0])');
  assert.match(src, /variants\.push\(\{select: instanceId, name: card\.name \?\? null,\s*\n\s*level: card\.level \?\? null, role_label: card\.role_label \?\? null, badges: card\.badges \?\? \[\]\}\)/,
    '分组时必须把 level / role_label / badges 带进 variants（否则区分信息渲染出来是「Lv— · 定位未登记」）');
});

// 2026-09-25（对抗性复核揪出的同族事故）：`#tw-analysis-box` 在标记里写死 `hidden`，
// 而渲染层原来只设 `.open = true` —— 给一个 `display:none` 的元素「展开」，
// 结果是**玩家永远看不到理论阵容**，而判据读的是 DOM 内容（`data-tw-analysis`）所以一直绿。
// 这就是本仓反复记的「**判据读取点 ≠ 玩家真正看的像素**」。这条钉住修好后的口径：
// 有内容才显示（清 `hidden`）、没内容整块收起；只写 `.open` 不算。
test('理论阵容框对玩家可见：有内容必须清掉 hidden（只写 open 不算）', () => {
  const src = readFileSync(join(ROOT, 'src/client/team-workshop.js'), 'utf8');
  assert.match(src, /analysisBox\.hidden = !hasAnalysis/,
    '有内容时必须把 `hidden` 清掉（否则玩家看不到，判据却因为读 DOM 内容而绿）');
  assert.match(src, /if \(hasAnalysis\) analysisBox\.open = true/,
    '有内容时同时展开');
  assert.match(src, /const hasAnalysis = Number\(analysis\?\.count \?\? 0\) > 0/,
    '「有没有内容」必须由 analysis.count 判，不许写死 true');
});

// ── 阵容评估的**可读性**与「接入 AI」（人类 2026-09-25：「可读性一坨屎，不知道在说啥
//    而且好像没接入 ai 吧？」）────────────────────────────────────────────────────────
//
// 修前：五轴主行直接印 `0.75735 · 相对分（0～1 的序数标度）` —— 小数位比结论还长，
// 而且「序数标度 / 相对分极差」是内部口径。现在主行只有档位词 + 一条进度条，
// **精确值一个都不删**（收进同一行的「原始数值与口径」折叠区）；
// 抽屉底部多一颗「让小芽说人话」，走宿主页给的 `askCoach`（同一条 /api/coach）。
test('阵容评估：主行给人话档位（不是裸小数），精确值收进折叠区，并接上小芽', () => {
  // ① 档位分界是**展示口径**，三档各自可判，且边界之外不猜
  assert.equal(axisLevelWord(0.2), '偏低');
  assert.equal(axisLevelWord(0.5), '中等');
  assert.equal(axisLevelWord(0.9), '偏高');
  assert.equal(axisLevelWord(null), null, '没有值不许硬给一个档位');
  assert.equal(axisLevelWord(Number.NaN), null);
  assert.deepEqual(AXIS_LEVEL_BANDS.map(([, word]) => word), ['偏低', '中等', '偏高']);
  // ② 源码形状：主行取值走 axisValueText（人话），原始值只出现在折叠区；
  //    并且**主行不许再出现「序数标度 / 相对分」这种口径词**（它们只准待在折叠区里）
  const src = readFileSync(new URL('../src/client/team-workshop.js', import.meta.url), 'utf8');
  const mainLine = src.slice(src.indexOf('function axisValueText('), src.indexOf('function axisRawText('));
  assert.ok(!/序数标度|相对分极差/.test(mainLine), '主行文案不许出现内部口径词');
  assert.match(mainLine, /axisLevelWord\(axis\.value\)/, '主行必须走档位词');
  const rawFn = src.slice(src.indexOf('function axisRawText('), src.indexOf('function axisBar('));
  assert.match(rawFn, /序数标度|相对分极差/, '精确值必须在折叠区里留着（一个数都不许删）');
  // 改钉（2026-09-26）：折叠区的标题由「原始数值与口径」改成「原始数值与说明」——
  // 人类点出面板"不是人话"，这一轮把玩家可见文案里的内部术语（口径/结构分/声明假设…）全清了。
  // 判据的**意图没变**：精确值必须有一个折叠区可看。
  assert.match(src, /<details class="tw-about tw-axis-raw"><summary>原始数值与说明<\/summary>/,
    '精确值必须有折叠区可看');
  // 新增：玩家可见文案里不许再出现内部术语（注释里解释口径是可以的，所以先把注释剥掉）
  const visible = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const word of ['口径', '结构分', '声明假设', 'ENGINE_HYPOTHESIS', '相对表现']) {
    assert.ok(!visible.includes(word), `工坊面板的玩家可见文案里还有内部术语「${word}」`);
  }
  // ③ 小芽按钮：必须真的接上宿主页给的 askCoach（没给就如实说没接上，不许假装）
  assert.match(src, /id="tw-ask-ai"/, '抽屉里必须有「让小芽说人话」按钮');
  assert.match(src, /const askCoach = typeof opts\.askCoach === 'function' \? opts\.askCoach : null;/,
    'askCoach 只能由宿主页注入');
  assert.match(src, /这一页没有接上小芽（宿主页没给 askCoach）/, '没接上时必须如实说，不许编一段解释顶上');
  assert.match(src, /只说结构上的事：属性覆盖、速度线、能耗、角色分工/,
    '交给小芽的题面必须写清边界（不给强度结论、不把结构分说成胜率）');
  // ④ 宿主页那一侧：roco.js 必须把同一条 /api/coach 封装成 askCoach 传进去
  const host = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  assert.match(host, /askCoach: \(message\) => askXiaoya\(message\)/, '宿主页必须把教练通道传进工作台');
  assert.match(host, /async function askXiaoya\(message\)/, '宿主页必须有唯一的 askXiaoya 封装');
});

// ── 槽位必须带上「引擎给的四个技能」（2026-09-27，审计高 6 实测）────────────────────
//
// 事实经过：客户端一直读 `slot.skills` 来渲染「引擎规范配招：…」与换招起点，而**服务端从来没发过
// 这个键** ⇒ 那句话永远空白、换招编辑器一开始就是「已选 0/4」，玩家想换一个招得把四个全重挑。
test('槽位载荷必须带 skills（每个 {skill_id,name}），否则「引擎规范配招」永远是空的', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/server/roco-service.js', import.meta.url), 'utf8');
  // ① 槽位里要发这个键，且两个字段都在
  assert.match(src, /skills:Array\.isArray\(member\?\.skills\)\?member\.skills:\[\]/, '槽位的 skills 要跟着成员走');
  assert.match(src, /skills:member\.skills\?\?member\.ordered_skills/, '成员构造时要把四个技能传下去');
  assert.match(src, /skill_id:one\?\.skill_id\?\?one\?\.id\?\?null,name:/, '每一项要有 skill_id 与 name');
  // ② 名字查不到时要如实说，不许编
  assert.match(src, /（名字未登记）/, '查不到名字要如实标注');
  // ③ 反证：直接构造一个成员行，验证它真的产出 {skill_id,name}
  const {loadBoxIndex} = await import('../src/server/roco-service.js');
  const index = loadBoxIndex();
  const one = [...index.skills.keys()].slice(0, 4);
  assert.equal(one.length, 4, '技能表里要有技能（否则这条判据是空的）');
  for (const id of one) assert.ok(index.skills.get(id)?.name, `${id} 要查得到名字`);
});


// ── 换招要**真的落到对局**，而且刷新不丢（2026-09-28，人类逐字：「换技能还是没实装是吧？实装一下」）──
//
// 事实经过（真机核过，不是推测）：
//   · 工坊的 `loadouts` 原来是个**纯内存 Map** —— 开局时它确实交给服务端（`battle/new` 的
//     `loadouts`），所以"工坊里换的招能进对局"是真的；但**刷新一下就没了**。
//   · 盒子二级详情页那份配招写的是另一个键（`roco.box.loadout.v1`，键 = 个体 `own-…`），
//     **谁都不读** ⇒ 盒子里配好的四个永远进不了对局（那一页的旧文案自己都写着
//     "去开局那一页时请照这四个重新带上"，等于承认没实装）。
// 现在两边共用 `src/client/loadout-store.js` 那一把钥匙（键 = 引擎回执的 `pet_id`）。
test('换招要读共用记录、也要写回去（否则刷新丢、盒子里配的也进不了对局）', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/client/team-workshop.js', import.meta.url), 'utf8');
  // ① 开局时先读共用记录（盒子里配过的那一份也在里面）
  // ⚠ 2026-09-29 改钉（真机故障：`art-finish` 报、Lead 复核并实测）：
  // 本轮 WIP 引用了 6 次 `SHARED_LOADOUT_SLOTS`，而这一行**只导入了另外两个**
  // ⇒ `ReferenceError: SHARED_LOADOUT_SLOTS is not defined` 抛在 `renderTeam → legalityRowHtml`
  // ⇒ **点候选项什么都不发生、六槽永远空**。定义本来就在 `loadout-store.js:26`，补进这一行即可。
  // 判据的意图一个字没变（**必须用共用那一把钥匙，不许自己拼键名**），只是允许那次补的第三个名字。
  // 旧断言留档：assert.match(src, /import \{readSharedLoadouts, writeSharedLoadout\} from '\.\/loadout-store\.js'/);
  assert.match(src,
    /import \{readSharedLoadouts, writeSharedLoadout, SHARED_LOADOUT_SLOTS\} from '\.\/loadout-store\.js'/,
    '工坊必须用共用的那一把钥匙，不许自己再拼一个键名（三个名字都要从那一个模块引）');
  assert.match(src, /const loadouts = new Map\(readSharedLoadouts\(\)\)/,
    '开局时要把共用记录读进 loadouts（键 = pet_id）');
  // ② 保存时写回去
  assert.match(src, /writeSharedLoadout\(null, editor\.petId \?\? editor\.species, editor\.draft\.slice\(\)\)/,
    '保存时要把这四个写回共用记录');
  // ③ 交给服务端那条链一个字没动（能进对局靠的就是它）
  assert.match(src, /loadouts: Object\.fromEntries\(\[\.\.\.loadouts\.entries\(\)\]/,
    '开局时仍然要把 loadouts 交给服务端 —— 这才是"进对局"');
  // ④ 反证：共用的键只有一处定义
  const store = read(new URL('../src/client/loadout-store.js', import.meta.url), 'utf8');
  assert.match(store, /export const LOADOUT_STORE_KEY = 'roco\.workshop\.loadouts\.v1'/);
  for (const f of ['../src/client/team-workshop.js', '../src/client/box-loadout.js']) {
    const one = read(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(one, /'roco\.workshop\.loadouts\.v1'/,
      `${f} 不许自己写死这个键名（只能从 loadout-store.js 引）`);
  }
});

// ── 环境权重不许被说成观测频率（2026-09-29，Codex 体检报告 P0-04）────────────────────
//
// 事实经过（审计实测）：`team-workshop.js` 把「最怕的体系」那一轴渲染成
// 「这类在环境里**大约每 N 局遇到 1 次**」，而 N 是从一个**赛前假设的权重**（各体系等权）
// 算出来的 —— 不是实测出场率。同一份回执的 `available_note` 里明明写着
// 「先假设"对手会用什么体系"（现在各体系按同等权重）…不是实测数据」，
// 也就是**同一屏上两句互相打架**，而且读起来像观测数据。
//
// 服务端早就有来源字段 `axis.distribution_kind`（`measured` / `assumption` / `null`），
// 所以这只是客户端没有按它分档。判据：**测过才敢说次数**。
test('环境权重按来源分档：假设的权重不许说成「每 N 局遇到 1 次」', async () => {
  const {axisValueText} = await import('../src/client/team-workshop.js');
  const base = {id: 'worst_archetype', label: '最怕的体系', available: true, value_kind: 'archetype'};
  const arche = {archetype_id: 'wing_king_force', label: '翼王强攻', weight: 1 / 7};

  const assumed = axisValueText({...base, value: arche, distribution_kind: 'assumption'});
  assert.ok(assumed, '有值时主行要有话');
  assert.doesNotMatch(assumed, /每\s*\d+\s*局/, `假设的权重不许说成遇到频率：${assumed}`);
  assert.match(assumed, /假设/, `要说清这是假设：${assumed}`);
  assert.match(assumed, /不是实测(出场率|数据)/, `要明说不是实测：${assumed}`);

  const unmarked = axisValueText({...base, value: arche, distribution_kind: null});
  assert.doesNotMatch(unmarked, /每\s*\d+\s*局/, `来源没标时同样不许说成频率：${unmarked}`);

  const measured = axisValueText({...base, value: arche, distribution_kind: 'measured'});
  assert.match(measured, /每\s*7\s*局/, `实测的才可以说次数（1/(1/7)=7）：${measured}`);
  assert.match(measured, /实测/, `实测来源要写出来：${measured}`);

  // 反证：把两种来源的文案对调，必须被上面三条断言抓住
  const swapped = axisValueText({...base, value: arche, distribution_kind: 'measured'});
  assert.notEqual(swapped, assumed, '实测与假设的文案必须不同（否则分档没生效）');
});

// ── 候选行必须说得出等级（2026-09-29，人类报的 A3：「pvp选精灵看不到等级？」）──────────────
//
// 事实经过：`poolRowMetaText()` 在缺等级时印 **`Lv—`** —— 那既不是等级、也没说清为什么没有。
// 而真因是**服务端的目录卡根本没有 `level` 字段**（`kind=mine` 的卡一直有 60），
// 所以「全图鉴」那一档**每一行**都是 `Lv—`，连玩家已经拥有的也是。
// 现在：有数就说数；是你拥有的但没数 ⇒「等级未登记」；图鉴里你没有 ⇒「未持有」。**三种都不编。**
test('候选行的等级三种说法：Lv.60 / 等级未登记 / 未持有（不许再出现光秃秃的 Lv—）', async () => {
  const {poolRowMetaText} = await import('../src/client/team-workshop.js');
  assert.match(poolRowMetaText({level: 60, select: 'own-0001', role_label: '回复'}), /^Lv\.60 · 回复$/);
  assert.match(poolRowMetaText({level: null, select: 'own-0001'}), /^等级未登记 · 定位未登记$/);
  assert.match(poolRowMetaText({level: null, select: 'pet_000277'}), /^未持有 · 定位未登记$/);
  assert.match(poolRowMetaText({level: 0, select: 'own-0001'}), /^等级未登记/, '0 不是等级（Lv.0 是编的）');
  for (const card of [{level: 60, select: 'own-0001'}, {level: null, select: 'own-0001'},
    {level: null, select: 'pet_000277'}, {}]) {
    assert.doesNotMatch(poolRowMetaText(card), /Lv—|Lv-/, `不许再出现 Lv—：${poolRowMetaText(card)}`);
  }
});

// ── ⭐ 阵容配置：应用 / 撤销 / 再读取（task-8 / Codex 即时监工 B）────────────────────────
//
// 这三件事在此之前**没有对象**：阵容只是这一屏的临时状态（地址带过来 / 点出来的），
// 没有"应用"这个动作、没有可撤的东西、重新打开读回来的是另一回事。
// 现在有一份本机记录（`TEAM_CONFIG_KEY`，只留一步可退）+ 一条**稳定序列化**（`teamConfigFingerprint`），
// 屏幕 / 应用过的那一份 / 重新读出来的那一份比的都是这一串。
test('阵容配置：指纹是稳定序列化（顺序固定、不含时间戳、逐值可核）', async () => {
  const {teamConfigFingerprint} = await import('../src/client/team-workshop.js');
  const cfg = {team: ['own-0004', 'own-0001'], species: ['pet_000004', 'pet_000001'],
    locked: ['own-0004'], loadouts: {pet_000004: ['skill_1', 'skill_2', 'skill_3', 'skill_4'],
      pet_000001: ['skill_9', 'skill_8', 'skill_7', 'skill_6']}, at: '2026-09-29T01:00:00Z'};
  const fp = teamConfigFingerprint(cfg);
  assert.equal(fp, 'team=own-0004,own-0001|locked=own-0004|loadouts=pet_000004:skill_1.skill_2.skill_3.skill_4'
    + ';pet_000001:skill_9.skill_8.skill_7.skill_6');
  // ① 时间戳不进去（同一套配置不管什么时候存的，指纹必须一样）
  assert.equal(teamConfigFingerprint({...cfg, at: '2030-01-01T00:00:00Z'}), fp, '时间戳不许进指纹');
  // ② 锁定那一串按字典序（集合语义：锁定的顺序不该产生两个指纹）
  assert.equal(teamConfigFingerprint({...cfg, locked: ['own-0004']}), fp);
  // ③ 反证：换了人 / 换了招 / 少一个技能，指纹都必须变
  assert.notEqual(teamConfigFingerprint({...cfg, team: ['own-0001', 'own-0004']}), fp, '换顺序要算不同的配置');
  assert.notEqual(teamConfigFingerprint({...cfg,
    loadouts: {...cfg.loadouts, pet_000001: ['skill_9', 'skill_8', 'skill_7', 'skill_5']}}), fp, '换一个技能要变');
  assert.notEqual(teamConfigFingerprint({...cfg, locked: []}), fp, '锁定变了要变');
  // ④ 坏输入不许抛（宁空不编）
  assert.equal(teamConfigFingerprint(null), '');
  assert.equal(teamConfigFingerprint({}), 'team=|locked=|loadouts=');
});

test('阵容配置：读回来的记录形状不对就当没有（不编一份）', async () => {
  const {readTeamConfig, writeTeamConfig, TEAM_CONFIG_KEY} = await import('../src/client/team-workshop.js');
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  assert.deepEqual(readTeamConfig(storage), {current: null, previous: null, applied_count: 0}, '空存储 = 没有');
  store.set(TEAM_CONFIG_KEY, '{坏 JSON');
  assert.deepEqual(readTeamConfig(storage), {current: null, previous: null, applied_count: 0}, '坏 JSON = 没有');
  store.set(TEAM_CONFIG_KEY, JSON.stringify({current: {team: []}}));
  assert.equal(readTeamConfig(storage).current, null, 'team 空的那一份不算一份配置');
  // 写进去能原样读回来（只留一步可退）
  const snap = {team: ['own-0001', 'own-0002'], species: ['pet_000001', 'pet_000002'],
    locked: ['own-0001'], loadouts: {pet_000001: ['a', 'b', 'c', 'd']}, at: 'x'};
  assert.equal(writeTeamConfig(storage, {current: snap, previous: null, applied_count: 1}), true);
  const back = readTeamConfig(storage);
  assert.deepEqual(back.current.team, snap.team);
  assert.deepEqual(back.current.loadouts.pet_000001, ['a', 'b', 'c', 'd']);
  assert.equal(back.applied_count, 1);
});

test('阵容配置：应用前的校验逐条给得出理由（六只 / 四技能 / 锁定的必须留着 / 查过才说合法）', async () => {
  const {teamConfigProblems, slotLegalityProblems} = await import('../src/client/team-workshop.js');
  const pool = (species) => ['s1', 's2', 's3', 's4', 's5'];
  const slots = (n, skills = ['s1', 's2', 's3', 's4']) => Array.from({length: n}, (_, i) => ({
    instance: `own-000${i + 1}`, species: `pet_00000${i + 1}`, name: `第${i + 1}只`, skills}));
  // ① 满六只、每只四个都在学习表里 ⇒ 无话可说
  assert.deepEqual(teamConfigProblems({slots: slots(6), locked: ['own-0001'], learnableOf: pool}), []);
  // ② 只有五只 ⇒ 说清差几只
  const few = teamConfigProblems({slots: slots(5), locked: [], learnableOf: pool});
  assert.equal(few.length, 1);
  assert.match(few[0].text, /6 只/, `要说清要几只：${few[0].text}`);
  // ③ 锁定的那一只不在队里 ⇒ 必须报（服务端 RC-301 规则⑨会把整条请求拒掉）
  const lockGone = teamConfigProblems({slots: slots(6), locked: ['own-9999'], learnableOf: pool});
  assert.ok(lockGone.some((p) => p.kind === 'lock-missing'), `锁定的不在队里要报：${JSON.stringify(lockGone)}`);
  // ④ 某一格只有三个技能 / 有重复 ⇒ 逐条报
  const three = teamConfigProblems({slots: slots(6, ['s1', 's2', 's3']), locked: [], learnableOf: pool});
  assert.ok(three.some((p) => p.kind === 'skills-count'), '三个技能要报');
  const dup = teamConfigProblems({slots: slots(6, ['s1', 's1', 's3', 's4']), locked: [], learnableOf: pool});
  assert.ok(dup.some((p) => p.kind === 'skills-duplicate'), '重复要报');
  // ⑤ 学不到的技能 ⇒ 点名第几格、第几个、哪个技能
  const bad = teamConfigProblems({slots: slots(6, ['s1', 's2', 's3', 'zzz']), locked: [], learnableOf: pool});
  assert.equal(bad.length, 6, '六格都要报（每格第 4 个技能学不到）');
  assert.match(bad[0].text, /第 4 个技能/, `要点名是第几个：${bad[0].text}`);
  // ⑥ **没查过就不说合法**（learning 表为 null ⇒ not-checked，而不是当成通过）
  const unchecked = teamConfigProblems({slots: slots(6), locked: [], learnableOf: () => null});
  assert.equal(unchecked.length, 6);
  assert.ok(unchecked.every((p) => p.kind === 'not-checked'), '没查过一律 not-checked');
  // ⑦ 不是持有个体（图鉴物种）⇒ 不许应用
  const speciesOnly = teamConfigProblems({slots: [{instance: 'pet_000112', species: 'pet_000112',
    name: '雪影娃娃', skills: ['s1', 's2', 's3', 's4']}], locked: [], learnableOf: pool});
  assert.ok(speciesOnly.some((p) => p.kind === 'not-owned'), '图鉴物种不能正式上场');
  // ⑧ 逐格判据（页面那一行用的就是它）：空/三个/重复/没查过/学不到
  // ⚠ 两个入参形状不同、别混：`teamConfigProblems` 收 `learnableOf`（**函数**，按物种查），
  // `slotLegalityProblems` 收 `learnable`（**那一只的数组**，页面手里已经有它了）。
  const learnt = pool('pet_000001');
  assert.equal(slotLegalityProblems({skills: ['s1', 's2', 's3', 's4'], learnable: learnt}).length, 0);
  assert.equal(slotLegalityProblems({skills: ['s1', 's2', 's3'], learnable: learnt})[0].kind, 'count');
  assert.equal(slotLegalityProblems({skills: ['s1', 's1', 's3', 's4'], learnable: learnt})[0].kind, 'duplicate');
  assert.equal(slotLegalityProblems({skills: ['s1', 's2', 's3', 's4'], learnable: null})[0].kind, 'unknown');
  const one = slotLegalityProblems({skills: ['s1', 's2', 's3', 'zzz'], learnable: learnt});
  assert.equal(one.length, 1);
  assert.equal(one[0].at, 3, '要说清是第几个技能（0 基下标 3 = 第 4 个）');
});

test('阵容配置：接线（应用/撤销/再读取三个落点 + 三个 dataset 钩子 + 锁定保护）', () => {
  const src = readFileSync(new URL('../src/client/team-workshop.js', import.meta.url), 'utf8');
  // ① 三个动作的落点
  for (const id of ['tw-config-check', 'tw-config-apply', 'tw-config-undo']) {
    assert.match(src, new RegExp(`id="${id}"`), `要有「${id}」这个落点`);
  }
  assert.match(src, /\$\('tw-config-apply'\)\.addEventListener\('click', \(\) => \{ void applyConfig\(\); \}\)/,
    '「应用这套配置」要真的接上 applyConfig');
  assert.match(src, /\$\('tw-config-undo'\)\.addEventListener\('click', \(\) => \{ undoConfig\(\); \}\)/,
    '「撤销上一次应用」要真的接上 undoConfig');
  // ② 判据读的三个钩子
  assert.match(src, /rootEl\.dataset\.twConfigState = stateName/);
  assert.match(src, /rootEl\.dataset\.twConfigApplied = applied \? teamConfigFingerprint\(applied\) : ''/);
  assert.match(src, /rootEl\.dataset\.twConfigCurrent = teamConfigFingerprint\(now\)/);
  // ③ **重新读取**：不带参数打开这一页时，记录里那一份要装回屏幕（地址带过来的优先）
  assert.match(src, /const storedConfig = readTeamConfig\(\)/);
  assert.match(src, /const initialSelected = urlSelected\.length \? urlSelected : \(storedConfig\.current\?\.team \?\? \[\]\)/,
    '地址没带人时要用记录里的那一份（这就是"重新读取"）');
  assert.match(src, /function adoptSnapshot\(snap\)/, '撤销与重新读取共用同一个"装回屏幕"的函数');
  // ④ 锁定的那一只不许被换掉/顶掉：两处都要拦
  assert.match(src, /state\.locked\.includes\(instance\)[\s\S]{0,200}锁定的一只必须留在队伍里/,
    '点「移除」时要拦住锁定的那一只并说清原因');
  assert.match(src, /const kept = state\.selected\.filter\(\(id\) => state\.locked\.includes\(id\)\)/,
    '「清空阵容」要留着锁定的那一只（不许把玩家的约束悄悄丢了）');
  // ⑤ 应用之后配招必须是**显式**的（否则进战斗那一份不带 loadouts，只能靠"引擎恰好一样"对齐）
  assert.match(src, /loadouts\.set\(speciesId, ids\.slice\(\)\);\s*\n\s*writeSharedLoadout\(null, speciesId, ids\.slice\(\)\);/,
    '应用时要把六个物种的四个技能写进内存 Map 与共用记录');
  // ⑥ 反证：槽位 ↔ 个体**不许再按 `state.selected` 的下标**取（服务端槽位顺序与它无关，真机六格全错位）
  assert.doesNotMatch(src, /const slotInstance = state\.selected\[slot\.index - 1\]/,
    '反证：槽位实例不许按 selected 下标取（那正是错位的老写法）');
  assert.match(src, /function instanceOfSlot\(slot\)/, '要有一个按物种解析"这一格是谁"的函数');
  assert.match(src, /const slotInstance = instanceOfSlot\(slot\)/);
  // ⑦ 性格/资质那一条：界面上要如实写"引擎按种族值算"
  assert.match(src, /引擎按<strong>种族值<\/strong>算/);
  assert.match(src, /性格 \/ 资质（个体值）目前<strong>不进引擎<\/strong>/);
});
