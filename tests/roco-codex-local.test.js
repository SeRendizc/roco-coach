// 图鉴字段问句（`codex-fact`）**必须本地成句**：判据 + 必红反证（2026-09-27）。
//
// **由来（真机探针抓到的漏答）**：8765 上问「喵喵的种族值是多少？」——**玩家最自然的问法** ——
// 答的是「这一问的答案在图鉴里，我先查一下再答。」。真机回执：`toolTrace: []`、
// `provider: 'local'`、`agentStop: undefined`。那不是答案，是一句**承诺**。
//
// 根因是两支各判一半、中间没人接：
//   · `policyFor` 判 `query_rules` / `codex-fact` ⇒ `pureFact` 为真，本意是走本地事实、0 次模型；
//   · 但 `localFactAnswer` 里**根本没有 `codex-fact` 这一支**（`pet-intro-ask` 之后直接跳到
//     `roster-list-ask`），函数一路落到结尾 `return null`；
//   · `localFactAsk` 也没放行这一族 ⇒ **有模型时**靠工具循环兜住（所以只测"有模型"的探针看不出来），
//     **没接模型时**（`provider.name==='local'`）那句占位草稿就原样交给了玩家。
//
// 这一组钉：
//   ① 没模型时也必须答出**回执里的数**（六维逐值 + 合计），不再是占位句；
//   ② 问哪一格答哪一格（速度 / 防御 / 属性 / 特性），且**不同格子给不同的数**（防"一句常量糊弄"）；
//   ③ 技能字段（威力/能耗）走 `kind:'skill'`；来源里没有静态威力时**照实说没有**（不许写 0）；
//   ④ 「技能表」与 `learnset-ask` **同一句话**（共用 `learnsetSentence`，两处不许走样）；
//   ⑤ fail closed：引擎说没这个名字 ⇒ 如实说没查到 + 622 图鉴边界，**正文一个数都不许有**；
//   ⑥ 重名（多形态）⇒ 列候选、要 pet_id，**不挑第一只替他答**；
//   ⑦ 零模型调用：规划器与正文生成各 0 次（纯事实题的口径）。
// 必红反证：`localFactAsk` 必须是 true（改前是 false）；两格问句必须给**不同**的数
//（改前两句都落到占位句 ⇒ 相同）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {buildContext, localFactAsk, policyFor, runCoach, localProvider} from '../src/coach/runtime.js';
import {configureRocoTools, resetRocoTools} from '../src/coach/toolbox.js';
import {freshMemory} from '../src/coach/memory.js';

/** 真机那一只（值取自归一化图鉴 `pets.json` 里喵喵的记录）。 */
const MIAOMIAO = {record: 'pet', pet_id: 'pet_000001', name: '喵喵', title: '喵喵', types: ['草系'],
  stats: {hp: 65, atk: 66, def: 49, spa: 66, spd: 91, spe: 33}, stat_total: 370,
  feature_skill_id: 'skill_000003',
  learnset_summary: {native: 16, blood: 0, stones: 0, total: 16}};

const LEAF_BEAM = {record: 'skill', skill_id: 'skill_000744', name: '叶绿光束', category: '攻击',
  element: '草系', energy: 4, damage_class: '魔攻', power: 90, power_status: 'static_value_present'};

/** 没有静态威力的那一档（真数据里 466/824 个技能都是这样）。 */
const NO_POWER = {...LEAF_BEAM, skill_id: 'skill_000745', name: '藤绞', power: null,
  power_status: 'not_provided_by_source'};

const context = (message) => buildContext(null, {pets: []}, null, null, 'meadow', message);

/**
 * 跑一轮：桥按 `kind` 回预置回执，**并且数模型调用次数**。
 * 模型一律用桩（永远 stop）——它被叫到就说明这条路没走本地事实。
 */
async function ask(question, {facts = {}, missing = false} = {}) {
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query(fact) {
      const base = {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: [`ev:${fact.kind}#${fact.name ?? fact.pet_id ?? '—'}`],
        error_type: null, failure_class: null};
      if (missing) {
        return {...base, ok: false, result: null, error_type: 'not_found',
          error: `未知精灵名：${fact.name}`};
      }
      const result = facts[fact.kind];
      // 桩桥要**像真引擎**：kind 与名字两个都对上才算命中，否则回 not_found
      //（不然"猜错档也照样有回执"，换档重查那条路就永远测不到）。
      // ⚠ 名字/ id 必须**先判有没有给**再比 —— 写成 `result.pet_id === fact.pet_id` 时，
      // 两边都是 undefined 会算命中（本判据第一版就是这么假绿的：按技能查「喵喵」拿到了精灵记录）。
      const nameHit = fact.name !== undefined
        && (result?.name === fact.name || result?.pet_name === fact.name
          || result?.queried_name === fact.name);
      const idHit = (fact.pet_id !== undefined && result?.pet_id === fact.pet_id)
        || (fact.skill_id !== undefined && result?.skill_id === fact.skill_id);
      const hit = Boolean(result) && result.record === fact.kind && (nameHit || idHit);
      if (!hit) {
        return {...base, ok: false, result: null, error_type: 'not_found',
          error: `未知${fact.kind === 'pet' ? '精灵' : '技能'}名：${fact.name ?? fact.pet_id}`};
      }
      return {...base, result};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  let plan = 0; let generate = 0;
  const provider = {name: 'stub-model',
    async plan() { plan += 1; return {stop: true}; },
    async generate(packet) { generate += 1; return String(packet?.text ?? ''); }};
  try {
    const answer = await runCoach({message: question, role: 'auto', context: context(question),
      memory: freshMemory(), provider});
    return {answer, calls: plan + generate, text: String(answer.text)};
  } finally {
    resetRocoTools();
  }
}

const PLACEHOLDER = '我先查一下再答';

test('① 没接模型时也要答出回执里的数（真机那句占位草稿不许再出现）', async () => {
  const {answer, text, calls} = await ask('喵喵的种族值是多少？', {facts: {pet: MIAOMIAO}});
  assert.doesNotMatch(text, new RegExp(PLACEHOLDER), `占位句又回来了：${text}`);
  // 六维逐值来自回执（一个都不许编、也不许少）
  for (const [key, value] of Object.entries(MIAOMIAO.stats)) {
    assert.match(text, new RegExp(String(value)), `六维里的 ${key}=${value} 必须在正文里：${text}`);
  }
  assert.match(text, /370/, '种族值合计来自回执');
  assert.match(text, /草系/, '属性来自回执');
  assert.match(text, /生命 65/, '六维要带中文项名（玩家认不出 hp/atk）');
  assert.equal(answer.agentStop, 'policy-fact-local', '纯事实路径收口');
  assert.equal(calls, 0, '纯事实题不许问模型（规划器 0 次 + 正文生成 0 次）');
  assert.ok((answer.toolTrace ?? []).length >= 1, '至少要真查一次引擎');
  // 必红反证：改前 `localFactAsk` 对 `codex-fact` 是 false（这一支没被放行）
  assert.equal(localFactAsk('喵喵的种族值是多少？', policyFor('喵喵的种族值是多少？', context('喵喵的种族值是多少？'))), true,
    'codex-fact 必须由本地事实放行');
});

test('② 问哪一格答哪一格：两格给不同的数（防"一句常量糊弄"）', async () => {
  const speed = await ask('喵喵的速度是多少？', {facts: {pet: MIAOMIAO}});
  const defence = await ask('喵喵的防御是多少？', {facts: {pet: MIAOMIAO}});
  assert.match(speed.text, /速度是 33/, speed.text);
  assert.match(defence.text, /物防是 49/, defence.text);
  // 必红反证：改前两句都落到同一句占位草稿 ⇒ 相同；现在必须**不同**
  assert.notEqual(speed.text, defence.text, '两格问句的正文必须不同');
  // 口语词映射到图鉴项名要说清（玩家说"防御"，图鉴那一格叫"物防"）
  assert.match(defence.text, /图鉴里这一格叫「物防」/, defence.text);
  const types = await ask('喵喵是什么属性？', {facts: {pet: MIAOMIAO, skill: LEAF_BEAM}});
  assert.match(types.text, /草系/, types.text);
  assert.doesNotMatch(types.text, new RegExp(PLACEHOLDER), types.text);
  // 这一格两边都有（精灵/技能都能有属性），名字在名单里没有它时 `nameIsElementTarget` 会先判成
  // **技能**档 ⇒ 查不到必须**换另一档再查一次**，不能就此答"查不到这一招"。
  assert.doesNotMatch(types.text, /技能「喵喵」/, `猜错档又没换档：${types.text}`);
  assert.deepEqual(types.answer.toolTrace?.map((row) => row.args?.kind), ['skill', 'pet'],
    '属性这一格要"先按判出来的档查、查不到换另一档"');
});

test('③ 技能字段：威力/能耗按回执答；来源里没有静态威力就照实说没有（不写 0）', async () => {
  const power = await ask('喵喵的叶绿光束威力多少？', {facts: {skill: LEAF_BEAM}});
  assert.match(power.text, /威力 90/, power.text);
  assert.match(power.text, /不是这一下的最终伤害/, '静态威力要说清口径（免得被当成伤害）');
  assert.match(power.text, /草系/, '属性来自回执');
  assert.equal(power.answer.toolTrace?.[0]?.args?.kind, 'skill', '这一族要按技能查');
  const none = await ask('喵喵的藤绞威力多少？', {facts: {skill: NO_POWER}});
  assert.match(none.text, /没有给这一招的静态威力/, none.text);
  assert.doesNotMatch(none.text, /威力 0|威力 1\b/, `缺威力不许写成 0：${none.text}`);
  const energy = await ask('喵喵的叶绿光束能耗几', {facts: {skill: LEAF_BEAM}});
  assert.match(energy.text, /能耗 4/, energy.text);
});

test('④ 「技能表」与学习表问句共用同一句话（两处不许走样）', async () => {
  const learnset = {record: 'learnset', pet_id: 'pet_000001', pet_name: '喵喵', total: 3,
    native: [{name: '藤绞'}, {name: '抓挠'}], blood: [{name: '叶绿光束'}], stones: []};
  const viaField = await ask('喵喵的技能表', {facts: {learnset}});
  const viaVerb = await ask('喵喵学得到哪些技能？', {facts: {learnset}});
  assert.match(viaField.text, /藤绞/, viaField.text);
  assert.match(viaField.text, /叶绿光束（血脉）|血脉：叶绿光束/, viaField.text);
  assert.equal(viaField.text, viaVerb.text, '两条问法必须给出同一句话（共用 learnsetSentence）');
  assert.doesNotMatch(viaField.text, new RegExp(PLACEHOLDER), viaField.text);
  // ⚠ 光比正文会漏掉一类真缺陷：这一支第一版把回执写成 `trace:[]`（抽函数时图省事），
  // 答案照样对、正文判据照样绿，但"这一问真查过什么"从回执里消失了 ——
  // 真机是 `--live` 打出「工具=[]」才抓到的。所以两条问法都必须**带回执**。
  for (const [what, result] of [['字段式', viaField], ['动词式', viaVerb]]) {
    assert.ok((result.answer.toolTrace ?? []).length >= 1, `${what}问法的回执不许为空`);
    assert.equal(result.answer.toolTrace?.[0]?.args?.kind, 'learnset', `${what}问法查的应是学习表`);
    assert.ok((result.answer.evidence ?? []).some((row) => /学习表读数/.test(String(row))),
      `${what}问法的出处里要有回执读数`);
  }
});

test('⑤ fail closed：引擎说没这个名字 ⇒ 如实说没查到，正文一个数都不许有', async () => {
  const {text, calls} = await ask('不存在的精灵名啊的种族值是多少？', {missing: true});
  assert.doesNotMatch(text, new RegExp(PLACEHOLDER), text);
  assert.match(text, /没核到|查不到|没有这个名字/, text);
  assert.match(text, /622/, '要说清是哪一份图鉴的边界');
  // 「622 只」是**如实说出的图鉴规模**（唯一允许出现的数），此外一个数值都不许有（编数据）
  assert.doesNotMatch(text.replace(/622/g, '图鉴规模'), /\d/, `查不到时不许出现任何数值（编数据）：${text}`);
  assert.equal(calls, 0, '查不到也不许改问模型');
});

test('⑥ 重名（多形态）：列候选、要 pet_id，不挑第一只替他答', async () => {
  const ambiguous = {record: 'pet', ambiguous: true, queried_name: '骨龙',
    matches: [{...MIAOMIAO, pet_id: 'pet_004001', name: '骨龙·幼'},
      {...MIAOMIAO, pet_id: 'pet_004002', name: '骨龙·首领', stat_total: 500}]};
  const {text} = await ask('骨龙的种族值是多少？', {facts: {pet: ambiguous}});
  assert.doesNotMatch(text, new RegExp(PLACEHOLDER), text);
  assert.match(text, /pet_004001/, text);
  assert.match(text, /pet_004002/, text);
  assert.match(text, /说一个 pet_id/, '要请玩家挑一只');
  assert.match(text, /2 只不同形态/, text);
});

test('⑧ 「特性」要把效果原文念出来（不是只报一个内部 id）', async () => {
  const trait = {record: 'skill', skill_id: 'skill_000003', name: '叶绿素', category: '特性',
    element: '草系', energy: 0, damage_class: null, power: null, is_trait: true,
    desc: '自身处于晴天时，速度提升。'};
  const {text, answer} = await ask('喵喵的特性是什么？', {facts: {pet: MIAOMIAO, skill: trait}});
  assert.match(text, /叶绿素/, text);
  assert.match(text, /晴天时，速度提升/, '效果说明要逐字来自图鉴回执');
  assert.equal(answer.toolTrace?.length, 2, '查精灵 + 查那条特性技能 = 两次只读调用');
  assert.equal(answer.toolTrace?.[1]?.args?.kind, 'skill', '第二次是查技能');
  // 图鉴里没有登记特性技能的精灵：如实说没有，别编一个名字
  const noTrait = await ask('喵喵的特性是什么？',
    {facts: {pet: {...MIAOMIAO, feature_skill_id: null}, skill: trait}});
  assert.match(noTrait.text, /没有登记特性技能/, noTrait.text);
});

test('⑨ 「进化」这一格绝不许拿六维来答（答非所问比不答更糟）', async () => {
  // 「喵喵的进化」本来由社区图鉴层（`evolutionLocalAnswer`）先答；这里换一个**那一层也认不出**的写法，
  // 逼它落到图鉴字段这一支 —— 此时正文必须是"我这边没有进化数据"，**不许**出现任何六维数字。
  const {text} = await ask('不存在进化那只啊的进化', {facts: {pet: MIAOMIAO}});
  assert.match(text, /没有数据|没收录/, text);
  assert.doesNotMatch(text, /种族值|物攻|魔攻|速度是/, `不许把六维当进化答：${text}`);
  assert.doesNotMatch(text, /\b\d{2}\b/, `不许出现面板数字：${text}`);
});

test('⑩ 技能字段配了精灵名 ⇒ 纠正问法，不许说"技能名可能记错了"（真机原话是错的）', async () => {
  // 真机实测：「喵喵的能耗是多少？」原来答「技能名可能记错了…」—— 玩家写的是**精灵名**，
  // 而「能耗/威力/类别」是**招式**的字段。这句话把方向指错了，比不答更糟。
  const {text, answer} = await ask('喵喵的能耗是多少？', {facts: {pet: MIAOMIAO, skill: LEAF_BEAM}});
  assert.match(text, /是精灵名/, text);
  assert.match(text, /叶绿光束能耗多少/, '要给出**能照说的问法**（带招式名的例子）');
  assert.doesNotMatch(text, /技能名可能记错了/, `不许把方向指错：${text}`);
  assert.deepEqual(answer.toolTrace?.map((row) => row.args?.kind), ['skill', 'pet'],
    '先按技能查（判定失败）→ 再按精灵查（确认它是精灵名）');
  // 反证：真正的技能名照旧答得上（这条纠正不许把正常那一档吃掉）
  const ok = await ask('喵喵的叶绿光束能耗几', {facts: {pet: MIAOMIAO, skill: LEAF_BEAM}});
  assert.match(ok.text, /能耗 4/, ok.text);
});

test('⑪ 数值回答读图鉴层时，**合计必须按现加**（不许留引擎那份旧合计）', async () => {
  // 真机实测：铠甲虫的六维改从图鉴层读之后，正文写成「种族值合计 555（生命 122 / 物攻 88 …）」——
  // 合计是引擎那份旧六维的和，逐项是新值，玩家自己一加就发现对不上。
  const LAYER = {record: 'pet', pet_id: 'pet_000012', name: '铠甲虫', types: ['虫系'],
    stats: {hp: 122, atk: 88, def: 121, spa: 39, spd: 77, spe: 75}, stat_total: 555};
  const {text} = await ask('铠甲虫的种族值是多少？', {facts: {pet: LAYER}});
  const total = 122 + 88 + 121 + 39 + 77 + 75;
  assert.match(text, new RegExp(String(total)), `合计要等于现加值 ${total}：${text}`);
  assert.doesNotMatch(text, /合计 555/, `不许留下与逐项矛盾的旧合计：${text}`);
});

test('⑦ 没接模型（localProvider）时也走这一支，不是只有桩模型才成立', async () => {
  // 真机那台就是"没接模型"：`provider` 默认 localProvider（`generate` 原样返回包里的正文）。
  const bridge = {
    baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10',
    async query() {
      return {ok: true, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 0, coverage: 1,
        evidence_ids: ['ev:pets.json#pet_000001'], error_type: null, failure_class: null, result: MIAOMIAO};
    },
  };
  configureRocoTools({client: bridge, stateVersion: 0});
  try {
    const question = '喵喵的种族值是多少？';
    const answer = await runCoach({message: question, role: 'auto', context: context(question),
      memory: freshMemory(), provider: localProvider});
    assert.doesNotMatch(String(answer.text), new RegExp(PLACEHOLDER), String(answer.text));
    assert.match(String(answer.text), /种族值合计 370/, String(answer.text));
    assert.equal(answer.provider, 'local', '这一路本来就不该问模型');
  } finally {
    resetRocoTools();
  }
});
