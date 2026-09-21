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
  WORKSHOP_PARAM_KEYS, parseWorkshopQuery, WORKSHOP_BADGES, loadWorkshopModules,
} from '../src/server/roco-service.js';
import {
  TEAM_WORKSHOP_BADGES, TEAM_SLOTS, AXIS_LABELS, mountTeamWorkshop,
} from '../src/client/team-workshop.js';
import {
  slotProblems, badgeProblems, nextCandidateProblems, axisProblems, badRequestProblems,
  playerCopyProblems, playerLayerProblems, evaluationFollowsTeamProblems, touchTargetProblems,
  mobileOrderProblems, deepTextValues, SLOT_COUNT, FORBIDDEN_PLAYER, PSEUDO_PRECISION,
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
const IDS = OWNED.instances.map((i) => i.instance_id).sort();

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
  assert.deepEqual([...WORKSHOP_PARAM_KEYS],
    ['mode', 'selected', 'locked', 'must_include', 'must_exclude', 'favourites_only', 'max_replacements']);
  log('[实际] 徽记 =', JSON.stringify(TEAM_WORKSHOP_BADGES));
  log('[实际] 参数白名单 =', WORKSHOP_PARAM_KEYS.join('/'));
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 路由契约：0 / 1 / 2 / 5 / 6 只五种形态
// ─────────────────────────────────────────────────────────────────────────

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
  for (const count of [2, 5]) {
    const result = await workshop(`selected=${IDS.slice(0, count).join(',')}`);
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
    const selectedSpecies = new Set(IDS.slice(0, count)
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
    const problems = playerCopyProblems(blob);
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
    assert.equal(routeAxis.value, directAxis.value, `${axisId} 的值与 RC-304 不一致`);
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
  assert.deepEqual(playerCopyProblems(deepTextValues(clean.json.player)), []);
  assert.deepEqual(badgeProblems({hasModeBadge: true, hasCandidateBadge: true,
    hasUnknownPrematch: true, hasFullUniverse: true, poolTotal: clean.json.facts.universe_size,
    mentionsLegacySlots: false}), []);
  // 坏样本：同一条判据翻转（塞一个工程键进去）
  assert.notDeepEqual(playerLayerProblems({slots: [{name: '音速犬', instance_id: 'own-0001'}]}), []);
  raw('干净样本的判据结果', {axes: [], player_layer: [], copy: []});
  log('[实际] 干净样本全过、坏样本翻红（判据不是恒真的）');
});
