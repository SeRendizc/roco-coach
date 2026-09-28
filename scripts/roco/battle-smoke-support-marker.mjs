#!/usr/bin/env node
/**
 * task-6 · **「这一手引擎会不会结算」的界面标记**：读数 + 判据 + 必红反证。
 *
 * 第一步（先量）与第二步（再标）的证据都从这里出：
 *
 *   1. **读数**：开局的 battle view 回执里，动作对象的键清单、以及有多少个动作带上了
 *      「这一手引擎还算不出来」的信息（`reports/roco/battle-smoke/support-marker.json`
 *      的 `step1_reading`）。改前那一份留在
 *      `unsupported-flag-probe.before.json`（那一刻的结论是「没有」）。
 *   2. **判据**：`markerProblems(view)` 是纯函数 —— 引擎说「还算不出来」的那一手，
 *      在回执里**必须**带一条 `support.note`；且那条文案里**不许**出现工程词；
 *      且**不许**因此把动作变灰/删掉。
 *   3. **必红反证**：`SELFTESTS` 里每一条都把判据该咬的东西摘掉，判据必须红。
 *
 * 用法：
 *   node scripts/roco/battle-smoke-support-marker.mjs                 # 自起进程内服务（默认，不打扰 8765）
 *   node scripts/roco/battle-smoke-support-marker.mjs --base=http://127.0.0.1:8765   # 量在跑的那台
 *   node scripts/roco/battle-smoke-support-marker.mjs --selftest-only # 只跑判据自检 + 反证
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SMOKE = join(ROOT, 'reports', 'roco', 'battle-smoke');
const OWNED = join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json');

const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const BASE_ARG = argOf('base');
const SELFTEST_ONLY = argv.includes('--selftest-only');

//: 玩家文案里**不许**出现的工程词（判据咬的是这一张表；表本身也从产品那边对齐）
export const ENGINEERING_WORDS = Object.freeze([
  'UnsupportedEffect', 'unsupported', 'skill_', 'pet_', 'legal_actions', 'payload',
  'token', 'provider', 'epoch', 'fallback', 'effect_support', 'parse',
  '效果原语', '未识别机制', '机制词', 'support_tier', 'SIMULATABLE', 'PARTIAL',
]);

//: 引擎的档位里，哪些是「它会结算」
const SETTLED_TIERS = new Set(['SIMULATABLE_UNVERIFIED', 'FULL_VERIFIED']);

/** 回执里所有带标记的技能动作。 */
export function markedActions(view) {
  return (view?.legal ?? []).filter((a) => a?.kind === 'skill' && a?.support?.note);
}

/** 判据（纯函数）：返回问题清单，空 = 过。 */
export function markerProblems(view, {mustMarkSkillIds = []} = {}) {
  const bad = [];
  const legal = (view?.legal ?? []).filter((a) => a?.kind === 'skill');
  const marked = new Map();
  for (const a of legal) {
    if (a.support?.note) marked.set(a.skill_id, a.support);
  }
  // ① 引擎说「还算不出来」的那一手必须有标记
  for (const sid of mustMarkSkillIds) {
    if (!marked.has(sid)) {
      bad.push(`技能 ${sid} 引擎说它还不会结算，但回执里没有标记（support.note 缺失）`);
    }
  }
  // ② 标记文案不许出现工程词
  for (const [sid, sup] of marked) {
    const note = String(sup.note ?? '');
    if (!note.trim()) bad.push(`技能 ${sid} 的标记是空的`);
    for (const w of ENGINEERING_WORDS) {
      if (note.includes(w)) bad.push(`技能 ${sid} 的标记里有工程词「${w}」：${note}`);
    }
    if (sup.tier && SETTLED_TIERS.has(String(sup.tier))) {
      bad.push(`技能 ${sid} 被标了「引擎还算不出来」，但档位是 ${sup.tier}（会结算的手不该标）`);
    }
    // ③ 显示的是**事实**，不是建议
    if (/^(别用|不要用|建议|推荐)/.test(note.trim())) {
      bad.push(`技能 ${sid} 的标记读起来像建议而不是事实：${note}`);
    }
  }
  // ④ 标记不许把动作变成不可点 / 删掉
  for (const a of legal) {
    if (a.disabled === true || a.support?.disabled === true) {
      bad.push(`技能 ${a.skill_id} 被标记之后变成不可点了（标记不许替引擎做决定）`);
    }
    if (a.kind !== 'skill' || !a.skill_id) bad.push('合法动作里出现了形状不对的技能动作');
  }
  return bad;
}

/** 必红反证：每条都把判据该咬的东西摘掉/弄脏，判据必须报出问题。 */
export const SELFTESTS = Object.freeze([
  {
    id: 'cp-marker-stripped',
    desc: '把标记摘掉 ⇒ 判据必须红（否则这条判据是空的）',
    mutate: (view) => {
      for (const a of view.legal ?? []) if (a?.support) delete a.support;
      return view;
    },
  },
  {
    id: 'cp-engineering-word',
    desc: '标记里塞一个工程词（UnsupportedEffect）⇒ 判据必须红',
    mutate: (view) => {
      const a = (view.legal ?? []).find((x) => x?.support?.note);
      if (a) a.support.note = `UnsupportedEffect：${a.support.note}`;
      return view;
    },
  },
  {
    id: 'cp-skill-id-leak',
    desc: '标记里塞一个技能 id ⇒ 判据必须红（玩家不该看到 skill_000671）',
    mutate: (view) => {
      const a = (view.legal ?? []).find((x) => x?.support?.note);
      if (a) a.support.note = `${a.support.note}（${a.skill_id}）`;
      return view;
    },
  },
  {
    id: 'cp-greyed-out',
    desc: '把被标的那一手变成不可点 ⇒ 判据必须红（标记不许替引擎做决定）',
    mutate: (view) => {
      const a = (view.legal ?? []).find((x) => x?.support?.note);
      if (a) a.disabled = true;
      return view;
    },
  },
  {
    id: 'cp-advice-not-fact',
    desc: '把标记改写成建议（「别用这一手」）⇒ 判据必须红',
    mutate: (view) => {
      const a = (view.legal ?? []).find((x) => x?.support?.note);
      if (a) a.support.note = `别用这一手：${a.support.note}`;
      return view;
    },
  },
]);

function clone(view) {
  return JSON.parse(JSON.stringify(view));
}

async function api(base, path, body, method = 'POST', cookie = '', csrf = '') {
  const headers = {origin: base};
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-coach-csrf'] = csrf;
  }
  const res = await fetch(base + path, {
    method, headers, ...(method === 'POST' ? {body: JSON.stringify(body)} : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = {ok: false, error: `非 JSON 回执：${text.slice(0, 120)}`};
  }
  return {status: res.status, json};
}

async function bootstrap(base) {
  const res = await fetch(`${base}/api/bootstrap`, {headers: {origin: base}});
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = /coach_session=[a-f0-9]{48}/.exec(setCookie)?.[0] ?? '';
  return {cookie, csrf: json?.csrf ?? null};
}

const HARD_GATE_SKILL = 'skill_000671';   // 「硬门」：描述里读不出减伤比例，引擎算不出来

/**
 * 找一只**学得到「硬门」**的实例，并给它配一套含「硬门」的四技能。
 * 学得到这件事**问产品自己**（`GET /api/roco/loadout/options`，走引擎的学习表），
 * 不在脚本里抄一份名单 —— 抄一份就会漂。
 */
async function pickHardGateLoadout(base, owned, cookie) {
  const builds = new Map(owned.battle_builds.map((b) => [b.owned_pet_instance_id, b]));
  for (const inst of owned.instances.slice(0, 80)) {
    const opts = await api(base, `/api/roco/loadout/options?pet=${inst.instance_id}`, null, 'GET', cookie);
    const learnable = (opts?.json?.learnable ?? []).map((r) => r.skill_id);
    if (!learnable.includes(HARD_GATE_SKILL)) continue;
    const mine = (builds.get(inst.instance_id)?.ordered_skills ?? inst.skills ?? [])
      .filter((sid) => sid !== HARD_GATE_SKILL && learnable.includes(sid));
    const picks = [HARD_GATE_SKILL, ...mine.slice(0, 3)];
    if (picks.length !== 4) continue;
    return {inst, picks};
  }
  return null;
}

async function main() {
  mkdirSync(SMOKE, {recursive: true});
  const owned = JSON.parse(readFileSync(OWNED, 'utf8'));

  // ── 判据自检 + 必红反证（不依赖任何服务）────────────────────────────────
  const fixture = {
    legal: [
      {kind: 'skill', skill_id: 'skill_000246', label: '抓挠', support: null},
      {kind: 'skill', skill_id: 'skill_000671', label: '硬门',
        support: {tier: 'PARTIAL', note: '这招有一部分引擎还不会算'}},
      {kind: 'charge', label: '聚能'},
    ],
  };
  const selftest = [];
  const baseProblems = markerProblems(fixture, {mustMarkSkillIds: [HARD_GATE_SKILL]});
  selftest.push({id: 'base-case', desc: '正常回执：判据必须是绿的', problems: baseProblems,
    ok: baseProblems.length === 0});
  for (const cp of SELFTESTS) {
    const problems = markerProblems(cp.mutate(clone(fixture)), {mustMarkSkillIds: [HARD_GATE_SKILL]});
    selftest.push({id: cp.id, desc: cp.desc, problems, ok: problems.length > 0});
  }
  const selftestOk = selftest.every((s) => s.ok);
  console.log(`[marker] 判据自检 + 必红反证：${selftest.filter((s) => s.ok).length}/${selftest.length} 过`);
  for (const s of selftest.filter((x) => !x.ok)) console.log(`  FAIL ${s.id}：${s.desc}`);

  const out = {
    schema_version: 1, artifact: 'battle-smoke-support-marker',
    generated_at: new Date().toISOString(),
    selftest, selftest_ok: selftestOk,
    engineered_words: ENGINEERING_WORDS,
  };

  if (SELFTEST_ONLY) {
    writeFileSync(join(SMOKE, 'support-marker.json'), JSON.stringify(out, null, 1));
    console.log(`→ ${join(SMOKE, 'support-marker.json')}`);
    process.exitCode = selftestOk ? 0 : 1;
    return;
  }

  // ── 真回执 ────────────────────────────────────────────────────────────
  let server = null;
  let base = BASE_ARG ? BASE_ARG.replace(/\/$/, '') : null;
  if (!base) {
    const {createCoachServer} = await import('../../src/server/index.js');
    server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const {cookie, csrf} = await bootstrap(base);
  const gateHit = await pickHardGateLoadout(base, owned, cookie);
  if (!gateHit) throw new Error('没有找到学得到「硬门」（skill_000671）的实例');
  const gate = gateHit.inst;

  const others = owned.instances.filter((i) => i.instance_id !== gate.instance_id).slice(0, 5);
  const team = [gate.instance_id, ...others.map((i) => i.instance_id)];
  const builds = new Map(owned.battle_builds.map((b) => [b.owned_pet_instance_id, b]));
  const loadouts = {};
  for (const iid of team) {
    const inst = owned.instances.find((i) => i.instance_id === iid);
    loadouts[inst.species_id] = (builds.get(iid)?.ordered_skills ?? inst.skills).slice();
  }
  loadouts[gate.species_id] = gateHit.picks.slice();
  const enemy = owned.instances.slice(100, 106).map((i) => i.instance_id);
  const started = await api(base, '/api/roco/battle/new', {
    mode: 'pvp-standard-six-pet', team, enemy_team: enemy, loadouts, seed: 20260921,
    strategy: 'greedy_damage',
  }, 'POST', cookie, csrf);
  const view = started?.json?.view ?? {};
  const actions = view.legal ?? [];
  const actionKeys = [...new Set(actions.flatMap((a) => Object.keys(a ?? {})))].sort();
  const marked = markedActions(view);

  out.base = base;
  out.base_kind = BASE_ARG ? 'external' : 'in-process（`createCoachServer`，与演示页同一份代码）';
  out.hard_gate = {instance_id: gate.instance_id, species_id: gate.species_id,
    name: gate.species_name, skill_id: HARD_GATE_SKILL, loadout: gateHit.picks};
  out.step1_reading = {
    battle_new_ok: started?.json?.ok === true,
    action_count: actions.length,
    action_keys: actionKeys,
    dedicated_marker_keys_before: [],
    actions_with_marker: marked.length,
    marked: marked.map((a) => ({skill_id: a.skill_id, skill_name: a.skill_name, ...a.support})),
    reading: marked.length
      ? `有：action 上带 \`support\`（${marked.length} 个动作命中）。来源是引擎的逐技能档位，`
        + '不是前端名单。'
      : '没有：这一版回执里 action 仍然没有任何「这一手结算不了」的字段。',
  };
  out.judgement = {
    must_mark_skill_ids: [HARD_GATE_SKILL],
    problems: markerProblems(view, {mustMarkSkillIds: [HARD_GATE_SKILL]}),
  };
  out.judgement.ok = out.judgement.problems.length === 0;
  out.ok = selftestOk && out.judgement.ok;
  writeFileSync(join(SMOKE, 'support-marker.json'), JSON.stringify(out, null, 1));
  console.log(`[marker] step1：动作键 ${actionKeys.join('/')}`);
  console.log(`[marker] step1：带标记的动作 ${marked.length} 个 → `
    + JSON.stringify(marked.map((a) => ({skill_id: a.skill_id, note: a.support?.note}))));
  console.log(`[marker] 真回执判据：${out.judgement.ok ? '绿' : '红 ' + out.judgement.problems.join('；')}`);
  console.log(`→ ${join(SMOKE, 'support-marker.json')}`);
  if (server) server.close();
  process.exitCode = out.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) await main();
