#!/usr/bin/env node
/**
 * B 段 · 全量逐只最小战斗冒烟（**入口侧**，走产品真实的 HTTP 入口）。
 *
 * 为什么要有这一份：引擎能跑 ≠ 玩家能开。这一份量的是**入口那一跳**：
 *   `POST /api/roco/battle/new`（浏览器「开一局」按的就是它）
 *     → Node 把 `own-XXXX` 个体换算成物种 id
 *     → 把**详情页看到的那份四技能**（`loadouts`）原样交给引擎
 *     → 引擎 `validate_team` 逐条判合法性
 *   然后 `POST /api/roco/battle/advance` 一路打到结算。
 *
 * 逐只判据（每条都留原文）：
 *   ① 选进队：`GET /api/roco/box?detail=own-XXXX` 拿得到详情页的四技能
 *   ② 合法六只：`battle/new` 的队伍恰好 6 只、互不重复、全在名单里
 *   ③ 开局：HTTP 200 + `view.phase === 'battle'` + `view.self.pets.length === 6`
 *   ④ 配招传递：`view.self.loadouts[物种]` 与详情页逐格同名、`view.loadout_origin` 全是 `player`
 *   ⑤ 出手/结算（`--settle` 指定子集时）：advance 打到 `view.battle_result`
 *
 * 用法：
 *   node scripts/roco/battle-smoke-entry.mjs --base=http://127.0.0.1:8765
 *   node scripts/roco/battle-smoke-entry.mjs --limit=20 --settle=10
 *   node scripts/roco/battle-smoke-entry.mjs --only=own-0001,own-0271 --settle=all
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'battle-smoke');
const OWNED = join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json');
const MODE_ID = 'pvp-standard-six-pet';
const TEAM_SIZE = 6;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BASE = (argOf('base') ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const LIMIT = argOf('limit') ? Number(argOf('limit')) : null;
const ONLY = argOf('only') ? new Set(argOf('only').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const SETTLE_ARG = argOf('settle');
const OUT = argOf('out') ?? join(OUT_DIR, 'entry-sweep.json');

const INITIAL_VIEWS = new Map();   // instance_id -> battle/new 那一刻的 view（只在内存里用）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function api(path, body, method = 'POST') {
  const url = `${BASE}${path}`;
  // `Origin` 必须等于服务自己的 origin：`src/server/index.js` 对 POST 有
  // 「`req.headers.origin !== origin` → 403 请求来源或类型不正确」这一道 CSRF 闸。
  // 浏览器天然带对；脚本必须自己带上，否则量到的是 403 而不是真结论。
  const headers = {origin: BASE};
  if (method === 'GET') {
    return rawFetch(url, {method, headers});
  }
  // POST 还要过会话+CSRF：`GET /api/bootstrap` 发 `coach_session` cookie 并回 `csrf`，
  // 之后每个 POST 都要带 `x-coach-csrf`。页面就是这么做的，脚本照做。
  const session = await ensureSession();
  return rawFetch(url, {
    method,
    headers: {...headers, 'content-type': 'application/json', cookie: session.cookie,
      'x-coach-csrf': session.csrf},
    body: JSON.stringify(body),
  });
}

let SESSION = null;
async function ensureSession() {
  if (SESSION) return SESSION;
  const res = await fetch(`${BASE}/api/bootstrap`, {headers: {origin: BASE}});
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 下面按 null 处理 */ }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = /coach_session=[a-f0-9]{48}/.exec(setCookie)?.[0]
    ?? /coach_session=[a-f0-9]{48}/.exec(SESSION?.cookie ?? '')?.[0] ?? '';
  SESSION = {cookie, csrf: json?.csrf ?? null};
  if (!SESSION.csrf || !SESSION.cookie) {
    throw new Error(`拿不到会话（GET /api/bootstrap → HTTP ${res.status}，csrf=${JSON.stringify(SESSION.csrf)}）`);
  }
  return SESSION;
}

async function rawFetch(url, init) {
  const res = await fetch(url, init);
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = {ok: false, error: `非 JSON 回执：${oneLine(text, 200)}`};
  }
  return {status: res.status, json, raw: text};
}

function loadOwned() {
  const doc = JSON.parse(readFileSync(OWNED, 'utf8'));
  const instances = doc.instances;
  const builds = new Map(doc.battle_builds.map((b) => [b.owned_pet_instance_id, b]));
  return {doc, instances, builds};
}

/** 对手队：确定性的 6 个实例，与**我方那六只**严格不重复（引擎不允许重复上场）。 */
function enemyFor(instances, mineIdx, n, mineIds = []) {
  const mine = new Set(mineIds);
  const out = [];
  const seen = new Set();
  for (let k = 1; out.length < TEAM_SIZE && k <= n * 2; k += 1) {
    const cand = instances[(mineIdx + k * 37) % n];
    if (!cand) continue;
    if (mine.has(cand.instance_id) || seen.has(cand.instance_id)) continue;
    seen.add(cand.instance_id);
    out.push(cand);
  }
  return out;
}

function pickSettleSet(records, spec, instances) {
  if (!spec) return [];
  if (spec === 'all') return instances.map((i) => i.instance_id);
  if (/^\d+$/.test(spec)) {
    // 确定性抽样：等距取 N 只（覆盖整条 instance 轴，不是只取前 N）
    const n = Math.min(Number(spec), instances.length);
    const step = Math.max(1, Math.floor(instances.length / n));
    const picks = [];
    for (let i = 0; i < instances.length && picks.length < n; i += step) picks.push(instances[i].instance_id);
    return picks;
  }
  return spec.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── 入口逐只冒烟 ────────────────────────────────────────────────────────────
async function entrySweep({instances, builds, pool}) {
  const n = instances.length;
  const enemies_all = pool ?? instances;
  const records = [];
  let t0 = Date.now();
  for (let i = 0; i < n; i += 1) {
    const inst = instances[i];
    const rec = {
      instance_id: inst.instance_id, species_id: inst.species_id, species_name: inst.species_name,
      steps: {}, playable: false, failure: null,
    };
    const fillers = [];
    for (let k = 1; fillers.length < TEAM_SIZE - 1 && k < n; k += 1) {
      const cand = instances[(i + k) % n];
      if (cand && cand.instance_id !== inst.instance_id
          && !fillers.some((f) => f.instance_id === cand.instance_id)) fillers.push(cand);
    }
    if (fillers.length < TEAM_SIZE - 1) {
      rec.failure = {step: 'legal_six', text: `候选不足，凑不出 5 只补位（只有 ${fillers.length}）`};
      records.push(rec);
      continue;
    }
    const mine = [inst, ...fillers];
    const enemies = enemyFor(enemies_all, i, enemies_all.length, mine.map((m) => m.instance_id));
    if (enemies.length < TEAM_SIZE) {
      rec.failure = {step: 'legal_six', text: `对手队凑不齐 6 只（enemies=${enemies.length}，候选宇宙 ${enemies_all.length}）`};
      records.push(rec);
      continue;
    }

    // ① 详情页：拿到这一只在盒子里显示的那四个技能（按 order）
    const detail = await api(`/api/roco/box?detail=${inst.instance_id}`, null, 'GET');
    const detailSkills = detail?.json?.player?.skills;
    if (!Array.isArray(detailSkills) || detailSkills.length !== 4) {
      rec.steps.select = {ok: false, detail: {
        status: detail.status,
        error: detail?.json?.error ?? `详情页没给四技能（拿到 ${Array.isArray(detailSkills) ? detailSkills.length : 'null'} 格）`,
      }};
      rec.failure = {step: 'select', text: `详情页读不到四技能：${JSON.stringify(oneLine(detail?.json?.error ?? detail.raw, 200))}`};
      records.push(rec);
      continue;
    }
    rec.detail_skills = detailSkills.map((s) => ({order: s.order, name: s.name, energy: s.energy}));
    rec.steps.select = {ok: true, detail: `${inst.instance_id} → ${inst.species_id}（${inst.species_name}），详情页四技能 ${rec.detail_skills.map((s) => s.name).join('/')}`};

    // ②/③/④ 开局：六只 + 每只四技能，按**物种 id** 交配招（Node 会把 own-XXXX 换算成物种）
    const loadouts = {};
    for (const m of mine) {
      const b = builds.get(m.instance_id);
      const sids = b?.ordered_skills ?? m.skills;
      if (!Array.isArray(sids) || sids.length !== 4) {
        rec.failure = {step: 'legal_six', text: `${m.instance_id} 的构建里没有 4 个技能（battle_builds.ordered_skills=${JSON.stringify(sids)}）`};
        break;
      }
      loadouts[m.species_id] = sids.slice();
    }
    if (rec.failure) {
      records.push(rec);
      continue;
    }
    rec.submitted_loadouts = loadouts;
    rec.team = mine.map((m) => m.instance_id);
    rec.enemy_team = enemies.map((e) => e.instance_id);

    const started = await api('/api/roco/battle/new', {
      mode: MODE_ID, team: mine.map((m) => m.instance_id),
      enemy_team: enemies.map((e) => e.instance_id),
      loadouts, seed: 20260921, strategy: 'greedy_damage',
    });
    rec.steps.start = {ok: false, status: started.status, detail: null};
    if (started.status !== 200 || started?.json?.ok !== true) {
      rec.steps.start.detail = {status: started.status, error: started?.json?.error ?? oneLine(started.raw, 300)};
      rec.failure = {step: 'start', text: `HTTP ${started.status}：${oneLine(started?.json?.error ?? started.raw, 400)}`,
        error_type: started?.json?.error_type ?? null};
      records.push(rec);
      continue;
    }
    const view = started.json.view;
    const pets = view?.self?.pets ?? [];
    const okPhase = view?.phase === 'battle';
    const okSix = pets.length === TEAM_SIZE;
    rec.steps.start.ok = okPhase && okSix;
    rec.steps.start.detail = {status: started.status, phase: view?.phase, turn: view?.turn,
      pets: pets.length, battle_id: started.json.battle_id, mode: started.json.mode?.id ?? null};
    rec.steps.legal_six = {ok: okSix && new Set(mine.map((m) => m.instance_id)).size === TEAM_SIZE,
      detail: `我方六只 ${rec.team.join('、')}`};

    // ④ 配招传递：进战斗的那份四技能 === 详情页看到的那份
    const battleLoadouts = view?.self?.loadouts ?? null;
    const names = new Map();
    for (const s of view?.self?.skills ?? []) {
      const id = s?.skill_id ?? s?.id;
      const nm = s?.skill?.name ?? s?.name;
      if (id && nm) names.set(id, nm);
    }
    const perPet = [];
    for (const m of mine) {
      const got = battleLoadouts?.[m.species_id] ?? null;
      const gotNames = Array.isArray(got) ? got.map((id) => names.get(id) ?? id) : null;
      const want = m.instance_id === inst.instance_id
        ? rec.detail_skills.map((s) => s.name) : null;
      perPet.push({instance_id: m.instance_id, species_id: m.species_id,
        submitted: loadouts[m.species_id], got, got_names: gotNames,
        origin: view?.loadout_origin?.[m.species_id] ?? null,
        ...(want ? {detail_names: want,
          detail_matches: JSON.stringify(gotNames) === JSON.stringify(want)} : {})});
    }
    const allPassed = perPet.every((p) => p.origin === 'player'
      && JSON.stringify(p.got) === JSON.stringify(p.submitted));
    const targetMatches = perPet[0].detail_matches === true;
    rec.loadouts_per_pet = perPet;
    rec.steps.loadout_passthrough = {
      ok: allPassed && targetMatches,
      detail: {all_origin_player: perPet.every((p) => p.origin === 'player'),
        all_equal_submitted: perPet.every((p) => JSON.stringify(p.got) === JSON.stringify(p.submitted)),
        target_detail_matches: targetMatches,
        loadout_origin: view?.loadout_origin ?? null,
        loadout_note: view?.loadout_note ?? null},
    };
    rec.battle_id = started.json.battle_id;
    rec.view_state_version = view?.state_version ?? null;
    rec.steps.settle = {ok: null, detail: '未跑（--settle 指定子集时才推进）'};
    INITIAL_VIEWS.set(inst.instance_id, view);
    rec.playable = ['select', 'legal_six', 'start', 'loadout_passthrough'].every((k) => rec.steps[k]?.ok === true);
    if (!rec.playable) {
      rec.failure = {step: !rec.steps.loadout_passthrough.ok ? 'loadout_passthrough' : 'start',
        text: `配招传递判据没过：${JSON.stringify(rec.steps.loadout_passthrough.detail)}`};
    }
    records.push(rec);
    if (records.length % 25 === 0) {
      const ok = records.filter((r) => r.playable).length;
      console.error(`[entry] ${records.length}/${n} 入口可玩 ${ok} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  return records;
}

// ── 入口侧打到结算 ─────────────────────────────────────────────────────────
async function settleOne(rec, builds, instancesById) {
  const inst = instancesById.get(rec.instance_id);
  const target = inst.species_id;
  const steps = {switches: 0, switches_in: 0, skills_used: [], failures: [], trace: []};
  let bid = rec.battle_id;
  let sv = rec.view_state_version;
  let view = INITIAL_VIEWS.get(rec.instance_id) ?? null;
  let switchedOut = false, switchedIn = false;
  let turns = 0;
  if (!view) {
    rec.steps.settle = {ok: false, detail: {failures: [{text: '内存里没有开局 view（同一进程内才推进）'}]}};
    return rec;
  }
  const targetSlot = (view.self?.pets ?? []).find((p) => p.pet_id === target)?.slot ?? 0;
  const CAP = 300;
  let hitCap = false;
  for (let i = 0; i < CAP; i += 1) {
    if (view?.battle_result) break;
    if (i === CAP - 1) hitCap = true;
    const legal = view?.legal ?? [];
    if (!legal.length) {
      steps.failures.push({turn: view?.turn ?? null, text: '玩家没有合法动作'});
      break;
    }
    const skillActs = legal.filter((a) => a.kind === 'skill');
    const switches = legal.filter((a) => a.kind === 'switch');
    const charges = legal.filter((a) => a.kind === 'charge');
    const active = (view.self.pets ?? []).find((p) => p.slot === view.self.active) ?? null;
    // 兜底一定是**合法动作列表里的一个**（legal 非空时不可能选不出来）——
    // 上一版在「等着换回目标、但目标已经倒下」时返回 null，106 只因此被误报成「打不完」。
    const greedy = () => skillActs.slice()
      .sort((a, b) => (b.skill?.power ?? -1) - (a.skill?.power ?? -1))[0]
      ?? charges[0] ?? switches[0] ?? legal[0] ?? null;
    let pick = null;
    if (view.needs_replacement?.includes('player')) {
      pick = switches.find((a) => a.target_index === targetSlot) ?? switches[0] ?? greedy();
    } else if (active && active.pet_id === target && !active.fainted && !switchedOut && !switchedIn) {
      pick = switches.find((a) => a.target_index !== targetSlot) ?? greedy();
    } else if (switchedOut && !switchedIn) {
      pick = switches.find((a) => a.target_index === targetSlot) ?? greedy();
    } else if (active && active.pet_id === target && !active.fainted) {
      // 还没出过的先出，**贵的先出**（能量有限、这一只还可能中途倒下）。
      // 四个都出过之后**出招，不许无脑聚能**：上一版在这里 `?? charges[0]`，
      // 于是目标四招用完就一直聚能，两边谁也打不完 —— own-0007 卡到脚本上限就是这么来的
      // （是**脚本策略**的问题，不是引擎不会打：引擎侧同一条队 30 回合内就结算了）。
      const byId = new Map(skillActs.map((a) => [a.skill_id, a]));
      const unused = (rec.submitted_loadouts?.[target] ?? [])
        .filter((sid) => byId.has(sid) && !steps.skills_used.includes(sid))
        .sort((x, y) => (byId.get(y).skill?.energy ?? -1) - (byId.get(x).skill?.energy ?? -1));
      pick = unused.length ? byId.get(unused[0]) : greedy();
    } else {
      pick = greedy();
    }
    if (!pick) {
      steps.failures.push({turn: view?.turn ?? null, text: '选不出一手'});
      break;
    }
    const action = {kind: pick.kind};
    for (const k of ['skill_id', 'target_index', 'item_id', 'magic_id']) if (pick[k] !== null && pick[k] !== undefined) action[k] = pick[k];
    // 出手留痕：失败时要能把这一局**逐手复现**（引擎是确定性的：同 seed + 同动作串 = 同一局）
    steps.trace.push([action.kind, action.skill_id ?? action.target_index ?? action.item_id ?? action.magic_id ?? null].join(':'));
    const res = await api('/api/roco/battle/advance', {battle_id: bid, action, state_version: sv});
    if (res.status !== 200 || res?.json?.ok !== true) {
      steps.failures.push({turn: view?.turn ?? null, action, trace_index: steps.trace.length - 1,
        text: `HTTP ${res.status}：${oneLine(res?.json?.error ?? res.raw, 400)}`,
        error_type: res?.json?.error_type ?? null});
      break;
    }
    const before = view;
    view = res.json.view;
    sv = view?.state_version ?? sv;
    turns = view?.turn ?? turns;
    if (action.kind === 'switch' && before?.needs_replacement?.includes('player') !== true) {
      if (!switchedOut && action.target_index !== targetSlot) switchedOut = true;
      else if (switchedOut && action.target_index === targetSlot) switchedIn = true;
    }
    if (action.kind === 'switch') steps.switches += 1;
    if (action.kind === 'skill' && !steps.skills_used.includes(action.skill_id)) steps.skills_used.push(action.skill_id);
  }
  if (hitCap && steps.failures.length === 0) {
    steps.failures.push({turn: view?.turn ?? null, text: `打到第 ${CAP} 手仍未结算（脚本上限，不是引擎失败）`});
  }
  rec.steps.settle = {
    ok: view?.battle_result !== null && view?.battle_result !== undefined && steps.failures.length === 0,
    detail: {result: view?.battle_result ?? null, turns, switches: steps.switches,
      switched_out: switchedOut, switched_in: switchedIn, skills_used: steps.skills_used,
      failures: steps.failures, trace: steps.trace},
  };
  rec.full_playable = rec.playable && rec.steps.settle.ok === true;
  if (!rec.steps.settle.ok) {
    rec.failure = {step: 'settle', text: JSON.stringify(steps.failures).slice(0, 500)};
  }
  return rec;
}

// ── 组合测试：随机六只 × N 组 + 玩家实际六只 ────────────────────────────────
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function comboRun({instances, builds, all}, {label, ids}) {
  const byId = new Map(instances.map((i) => [i.instance_id, i]));
  const loadouts = {};
  const team = [];
  for (const id of ids) {
    const inst = byId.get(id);
    const b = builds.get(id);
    loadouts[inst.species_id] = (b?.ordered_skills ?? inst.skills).slice();
    team.push(id);
  }
  const idx = all.findIndex((i) => i.instance_id === ids[0]);
  const enemies = enemyFor(instances, idx < 0 ? 0 : idx, instances.length, team);
  const started = await api('/api/roco/battle/new', {
    mode: MODE_ID, team, enemy_team: enemies.map((e) => e.instance_id),
    loadouts, seed: 20260921, strategy: 'greedy_damage',
  });
  const rec = {label, team, loadouts, enemy_team: enemies.map((e) => e.instance_id),
    team_species: ids.map((id) => [id, byId.get(id)?.species_id ?? null]),
    steps: {start: {ok: started.status === 200 && started?.json?.ok === true,
      detail: {status: started.status, error: started?.json?.error ?? null}}},
    playable: false};
  if (!rec.steps.start.ok) {
    rec.failure = {step: 'start', text: `HTTP ${started.status}：${oneLine(started?.json?.error ?? started.raw, 400)}`};
    return rec;
  }
  const view = started.json.view;
  rec.battle_id = started.json.battle_id;
  rec.view_state_version = view?.state_version ?? null;
  rec.loadout_origin = view?.loadout_origin ?? null;
  rec.battle_loadouts = view?.self?.loadouts ?? null;
  rec.steps.loadout_passthrough = {
    ok: Object.entries(loadouts).every(([sp, sids]) =>
      JSON.stringify(view?.self?.loadouts?.[sp]) === JSON.stringify(sids)),
    detail: {origin: view?.loadout_origin ?? null,
      equal: Object.entries(loadouts).every(([sp, sids]) =>
        JSON.stringify(view?.self?.loadouts?.[sp]) === JSON.stringify(sids))},
  };
  // 打到结算：用页面同样的 auto 之外的口径 —— 逐手挑「最强技能」，让这局真的打完
  let cur = view;
  let sv = cur?.state_version ?? 0;
  let turns = 0;
  const used = [];
  const failures = [];
  for (let i = 0; i < 200; i += 1) {
    if (cur?.battle_result) break;
    const legal = cur?.legal ?? [];
    if (!legal.length) { failures.push({turn: cur?.turn, text: '没有合法动作'}); break; }
    const skills = legal.filter((a) => a.kind === 'skill');
    const switches = legal.filter((a) => a.kind === 'switch');
    let pick = cur?.needs_replacement?.includes('player')
      ? (switches[0] ?? legal[0])
      : (skills.slice().sort((a, b) => (b.skill?.power ?? -1) - (a.skill?.power ?? -1))[0]
        ?? legal.find((a) => a.kind === 'charge') ?? switches[0] ?? legal[0]);
    const action = {kind: pick.kind};
    for (const k of ['skill_id', 'target_index', 'item_id', 'magic_id']) if (pick[k] !== null && pick[k] !== undefined) action[k] = pick[k];
    const res = await api('/api/roco/battle/advance', {battle_id: rec.battle_id, action, state_version: sv});
    if (res.status !== 200 || res?.json?.ok !== true) {
      failures.push({turn: cur?.turn, action, text: `HTTP ${res.status}：${oneLine(res?.json?.error ?? res.raw, 400)}`});
      break;
    }
    cur = res.json.view; sv = cur?.state_version ?? sv; turns = cur?.turn ?? turns;
    if (action.kind === 'skill' && !used.includes(action.skill_id)) used.push(action.skill_id);
  }
  rec.steps.settle = {ok: !!cur?.battle_result && failures.length === 0,
    detail: {result: cur?.battle_result ?? null, turns, skills_used: used.length, failures}};
  rec.playable = Object.values(rec.steps).every((s) => s.ok === true);
  if (!rec.playable) rec.failure = {step: 'settle', text: JSON.stringify(failures).slice(0, 400)};
  return rec;
}

async function main() {
  const t0 = Date.now();
  const {doc, instances: all, builds} = loadOwned();
  let instances = all;
  if (ONLY) instances = all.filter((i) => ONLY.has(i.instance_id));
  if (LIMIT) instances = instances.slice(0, LIMIT);
  mkdirSync(OUT_DIR, {recursive: true});

  const health = await api('/api/roco/status', null, 'GET');
  const records = await entrySweep({instances, builds, pool: all});

  const settleIds = pickSettleSet(records, SETTLE_ARG, instances);
  const byId = new Map(all.map((i) => [i.instance_id, i]));
  const settleRecords = [];
  for (const id of settleIds) {
    const rec = records.find((r) => r.instance_id === id);
    if (!rec || !rec.battle_id) {
      settleRecords.push({instance_id: id, playable: false,
        failure: {step: 'settle', text: '入口冒烟就没开成，无法推进'}});
      continue;
    }
    const done = await settleOne({...rec, steps: {...rec.steps}}, builds, byId);
    settleRecords.push({instance_id: id, full_playable: done.full_playable === true,
      entry_playable: done.playable,
      battle_result: done.steps.settle.detail.result, turns: done.steps.settle.detail.turns,
      switched_out: done.steps.settle.detail.switched_out,
      switched_in: done.steps.settle.detail.switched_in,
      skills_used: done.steps.settle.detail.skills_used,
      submitted: rec.submitted_loadouts?.[byId.get(id)?.species_id] ?? null,
      team: rec.team, enemy_team: rec.enemy_team, submitted_loadouts: rec.submitted_loadouts,
      trace: done.steps.settle.detail.trace,
      failure: done.failure ?? null});
    mergeSettle(records, done);
  }

  // 组合：随机六只 × 10 组 + 玩家实际六只
  const rnd = mulberry32(20260928);
  const combos = [];
  for (let g = 0; g < 10; g += 1) {
    const picked = [];
    while (picked.length < TEAM_SIZE) {
      const cand = all[Math.floor(rnd() * all.length)];
      if (cand && !picked.includes(cand.instance_id)) picked.push(cand.instance_id);
    }
    combos.push(await comboRun({instances: all, builds, all}, {label: `random-six-${g + 1}`, ids: picked}));
  }
  // 「玩家实际六只」：演示页登记的默认队伍（DEFAULT_TEAM）+ 盒子里前 3 只被锁定的实例。
  // 口径写明在报告里 —— 这是**本仓库里能找到的**「玩家实际会带的那几只」，不是凭空编的。
  const DEFAULT_TEAM = ['pet_000225', 'pet_000190', 'pet_000445'];
  const defaultIds = DEFAULT_TEAM.map((sp) => all.find((i) => i.species_id === sp)?.instance_id).filter(Boolean);
  const lockedIds = all.filter((i) => i.locked).slice(0, TEAM_SIZE - defaultIds.length).map((i) => i.instance_id);
  const playerIds = [...new Set([...defaultIds, ...lockedIds])].slice(0, TEAM_SIZE);
  combos.push(await comboRun({instances: all, builds, all}, {label: 'player-actual-six', ids: playerIds}));
  // 形态 + 特殊机制混合组：千棘盔两个形态（pet_000271 / pet_000378）+ 盒子里前 4 只被锁定的实例
  const thorn = ['pet_000271', 'pet_000378']
    .map((sp) => all.find((i) => i.species_id === sp)?.instance_id).filter(Boolean);
  const mixIds = [...new Set([...thorn,
    ...all.filter((i) => i.locked).map((i) => i.instance_id)])].slice(0, TEAM_SIZE);
  combos.push(await comboRun({instances: all, builds, all}, {label: 'form-and-mechanism-mix', ids: mixIds}));

  const out = {
    schema_version: 1,
    artifact: 'battle-smoke-entry',
    generated_at: new Date().toISOString(),
    base: BASE,
    mode_id: MODE_ID,
    entry: 'POST /api/roco/battle/new + /api/roco/battle/advance（浏览器「开一局」走的就是这两条）',
    server_health: health?.json?.health ?? null,
    default_team_in_service: health?.json?.default_team ?? null,
    counts: {
      total: records.length,
      entry_playable: records.filter((r) => r.playable).length,
      entry_blocked: records.filter((r) => !r.playable).length,
      select_ok: records.filter((r) => r.steps.select?.ok).length,
      start_ok: records.filter((r) => r.steps.start?.ok).length,
      loadout_passthrough_ok: records.filter((r) => r.steps.loadout_passthrough?.ok).length,
      settle_run: settleRecords.length,
      settle_ok: settleRecords.filter((r) => r.full_playable).length,
      full_playable: records.filter((r) => r.full_playable === true).length,
    },
    records,
    settle_records: settleRecords,
    combos,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({counts: out.counts, combos_ok: combos.filter((c) => c.playable).length,
    combos_total: combos.length, elapsed_s: out.elapsed_s}, null, 1));
  console.log(`→ ${OUT}`);
}

function mergeSettle(records, done) {
  const rec = records.find((r) => r.instance_id === done.instance_id);
  if (!rec) return;
  rec.steps.settle = done.steps.settle;
  rec.full_playable = rec.playable && done.steps.settle.ok === true;
  if (done.steps.settle.ok !== true && done.failure) rec.failure = done.failure;
}

await main();
