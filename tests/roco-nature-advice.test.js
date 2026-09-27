/**
 * 判据：性格/天分的**说法层**（数字 → 取舍）。
 *
 * 人类的两条要求：**不许纯机器算**（只回数值不合格）、**不许过拟合**（不许按精灵名/原话写死）。
 * 这一份用**生成的**用例来钉这两条：种族值随机生成、断言结果跟着输入变、断言文本里不出现精灵名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {raceOf, explainNature, adviceFor, compareIndividuals, RACE_SOURCE,
  natureTalentAsk, natureLocalAnswer, petMentionedIn} from '../src/coach/nature-advice.js';
import {runCoach, localProvider} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {panelOf, STAT_KEYS, STAT_NAMES, natures} from '../src/coach/talent.js';

const catalog = JSON.parse(readFileSync(new URL(
  '../data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', import.meta.url), 'utf8'));
const rows = Array.isArray(catalog) ? catalog : catalog.pets;

// 一个只用于判据的确定性 PRNG（和运行时代码无关，避免"用被测对象测被测对象"）
function mulberry(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('① 种族值来自归一化图鉴文件（不是抄进代码的数）', async () => {
  const sample = rows.find((row) => row.stats && row.name);
  const got = await raceOf(sample.pet_id);
  assert.ok(got, '按编号要查得到');
  for (const stat of STAT_KEYS) {
    assert.equal(got.race[stat], Number(sample.stats[stat]), `${stat} 必须与文件逐值相同`);
  }
  assert.equal((await raceOf(sample.name)).pet_id, sample.pet_id, '按名字也要查得到同一只');
  assert.match(RACE_SOURCE, /full-catalog\.json/, '来源要写清是哪一份快照');
});

test('② 查不到就 null（不许拿别的数顶）', async () => {
  assert.equal(await raceOf('这只精灵不存在'), null);
  assert.equal(await raceOf(''), null);
  assert.equal(await raceOf(null), null);
  const missing = adviceFor({race: null});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不猜|算不出来/, `要说清为什么给不了：${missing.reason}`);
});

test('③ 「换来什么 + 牺牲什么」两边都必须是现算的面板差值', async () => {
  const target = rows.find((row) => row.stats);
  const race = (await raceOf(target.pet_id)).race;
  const one = explainNature({race, talent: null, nature: '开朗'});
  assert.ok(one, '开朗是合法性格');
  assert.equal(one.gain.stat, 'spe');
  assert.equal(one.cost.stat, 'spa');
  // 独立复算：中性 vs 开朗，两面都必须对得上
  const neutral = panelOf({race, talent: null, nature: null}).panel;
  const kai = panelOf({race, talent: null, nature: '开朗'}).panel;
  assert.equal(one.gain.from, neutral.spe);
  assert.equal(one.gain.to, kai.spe);
  assert.equal(one.cost.from, neutral.spa);
  assert.equal(one.cost.to, kai.spa);
  assert.ok(one.gain.delta > 0 && one.cost.delta < 0, '长处必须变大、短处必须变小');
  assert.equal(explainNature({race, nature: '不存在的性格'}), null, '认不出就 null，不许编一条');
});

test('④ 防止纯机器算：每条建议都必须带"代价"，只报数不算合格', async () => {
  const race = (await raceOf(rows.find((row) => row.stats).pet_id)).race;
  const advice = adviceFor({race, priority: ['spe', 'atk'], limit: 6});
  assert.equal(advice.ok, true);
  assert.equal(advice.rows.length, 6);
  for (const row of advice.rows) {
    assert.match(row.text, /抬 \+20%/, `要说清换来了什么：${row.text}`);
    assert.match(row.text, /代价是/, `必须说清牺牲了什么：${row.text}`);
    assert.match(row.text, /\d+ → \d+/, `两边都要给面板数字：${row.text}`);
    assert.ok(row.gain.delta !== 0, '变化不能是 0');
  }
  // 反证：把"代价"那半句删掉就不合格 —— 判据不是只看文本存在
  const stripped = advice.rows[0].text.replace(/，代价是.*$/, '');
  assert.doesNotMatch(stripped, /代价是/, '（反证用）');
});

test('⑤ 排序规则写在明面上：先看你要的项，再看净收益', async () => {
  const race = (await raceOf(rows.find((row) => row.stats).pet_id)).race;
  const advice = adviceFor({race, priority: ['atk'], limit: 30});
  const firstFive = advice.rows.slice(0, 5);
  assert.ok(firstFive.every((row) => row.wanted), '前五条必须都是"抬物攻"的性格（物攻长处共 5 种）');
  assert.ok(advice.rows.slice(5).every((row) => !row.wanted), '之后才轮到别的项');
  // 想要的速度项变了，第一名也要跟着变（防止写死）
  const speed = adviceFor({race, priority: ['spe'], limit: 1}).rows[0];
  assert.equal(speed.gain.stat, 'spe');
  assert.equal(adviceFor({race, priority: ['atk'], limit: 1}).rows[0].gain.stat, 'atk');
});

test('⑥ 比两个个体：缺数据必须留白（天分 0 / 性格未知都要说出来）', async () => {
  const race = (await raceOf(rows.find((row) => row.stats).pet_id)).race;
  const blank = compareIndividuals({race, a: {nature: null, talent: null}, b: {nature: null, talent: null}});
  assert.equal(blank.ok, true);
  assert.ok(blank.caveats.some((row) => row.includes('性格')), `要提性格缺：${blank.caveats}`);
  assert.ok(blank.caveats.some((row) => row.includes('天分')), `要提天分缺：${blank.caveats}`);
  // 反证：两只都给了性格以后，性格那条 caveat 必须消失（不是永远都提示）
  const both = compareIndividuals({
    race, a: {nature: '开朗', talent: null}, b: {nature: '胆小', talent: null}});
  assert.ok(!both.caveats.some((row) => row.includes('还没有性格数据')), `给了性格就不该再提：${both.caveats}`);
  // diff 必须等于两个面板逐项相减
  for (const stat of STAT_KEYS) {
    assert.equal(both.diff[stat], both.panels.a[stat] - both.panels.b[stat], `${stat} 的差要一致`);
  }
  assert.equal(compareIndividuals({race: null, a: {}, b: {}}).ok, false, '没种族值不比');
});

test('⑦ 防过拟合：种族值随机生成，建议必须跟着变；文本里不许出现精灵名', () => {
  const rand = mulberry(20260926);
  const seen = new Set();
  const names = new Set(rows.map((row) => row.name).filter(Boolean));
  for (let i = 0; i < 30; i += 1) {
    const race = Object.fromEntries(STAT_KEYS.map((stat) => [stat, 20 + Math.floor(rand() * 130)]));
    const advice = adviceFor({race, priority: ['spe'], limit: 3});
    assert.equal(advice.ok, true);
    const text = advice.rows.map((row) => row.text).join(' ');
    for (const name of names) {
      assert.ok(!text.includes(name), `建议文本里不许出现精灵名（出现了 ${name}）—— 那说明有按名字写死的分支`);
    }
    seen.add(text);
  }
  assert.ok(seen.size > 20, `30 组随机种族值至少要给出 20 种不同说法（实际 ${seen.size}）—— 写死会退化成 1 种`);
});

test('⑧ 数字只有一个来源：说法层不自己实现公式（改了 talent.js 就跟着变）', () => {
  const src = readFileSync(new URL('../src/coach/nature-advice.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/talent\.js'/, '必须从 talent.js 取规则');
  assert.doesNotMatch(src, /1\.7\s*\*/, '不许把面板公式再抄一遍');
  assert.doesNotMatch(src, /0\.85\s*\*/, '同上');
  // 逐性格核对：说法层的每一步都与 talent.js 现算一致
  const race = {hp: 100, atk: 90, spa: 80, def: 70, spd: 60, spe: 110};
  for (const row of natures()) {
    const explained = explainNature({race, talent: null, nature: row.name});
    assert.equal(explained.gain.stat, row.up, `${row.name} 的长处`);
    assert.equal(explained.cost.stat, row.down, `${row.name} 的短处`);
    assert.ok(explained.text.includes(STAT_NAMES[row.up]) && explained.text.includes(STAT_NAMES[row.down]));
  }
});

test('⑨ 只认这三种形状；相性/技能/图鉴/阵容/闲聊一律不许被吃掉', () => {
  for (const q of ['皇家狮鹫用什么性格好？', '皇家狮鹫想抢速度，用什么性格？', '皇家狮鹫该配什么性格',
    '皇家狮鹫为什么用开朗？', '皇家狮鹫这两个个体差在哪？']) {
    assert.equal(natureTalentAsk(q), true, `「${q}」要认成性格/天分问句`);
  }
  // 反证：这些句子各有各的路，被这条吃掉就是抢别人的活
  for (const q of ['火系克制什么属性？', '皇家狮鹫有哪些技能？', '皇家狮鹫的种族值是多少？',
    '我这套阵容有什么短板？', '首发该上谁？', '你好', '随便聊聊', '能量上限是几个豆？']) {
    assert.equal(natureTalentAsk(q), false, `「${q}」不该被性格这一族吃掉`);
  }
  // 名字匹配取**最长**（真实的嵌套名：图鉴里「地鼠」与「遁地鼠」都在，前者是后者的子串）
  assert.equal(petMentionedIn('遁地鼠用什么性格')?.name, '遁地鼠', '不许被短名「地鼠」抢走');
  assert.equal(petMentionedIn('没有名字的一句话'), null);
});

test('⑩ 端到端：本地成句、0 次规划器调用，答案必须带取舍句；查不到就如实说', async () => {
  let plan = 0; let generate = 0;
  const provider = {name: 'stub', async plan() { plan += 1; return {stop: true}; },
    async generate(packet) { generate += 1; return String(packet?.text ?? ''); }};
  const context = {mode: 'camp', profile: {pets: [
    {id: 'pet_000118', name: '皇家狮鹫', types: ['翼系']},
    {id: 'pet_000137', name: '多多', types: ['地系']}]}};
  const ask = (message) => runCoach({message, role: 'auto',
    context: JSON.parse(JSON.stringify(context)), memory: freshMemory(), provider});

  const advice = await ask('皇家狮鹫想抢速度，用什么性格？');
  assert.match(String(advice.agentStop), /^policy-fact/, `要走本地事实：${advice.agentStop}`);
  assert.equal(plan, 0, '本地事实不许调规划器');
  assert.match(String(advice.text), /速度抬 \+20%/, `要说清换来了什么：${advice.text}`);
  assert.match(String(advice.text), /代价是/, '必须带代价（防止纯机器算）');
  assert.match(String(advice.text), /\d+ → \d+/, '要给面板数字');
  assert.match(String(advice.text), /开朗|胆小|急躁|热情|莽撞/, '要给出这一方向上的性格');

  const why = await ask('皇家狮鹫为什么用开朗？');
  assert.match(String(why.text), /开朗/, '要答到点名的那个性格上');
  assert.match(String(why.text), /代价是/, '解释也必须带代价');

  // 没点名的方向：按它自己最高的一项讲，并说清"为什么按这一项"
  const auto = await ask('皇家狮鹫用什么性格好？');
  assert.match(String(auto.text), /种族值最高的是/, `要说清默认方向的依据：${auto.text}`);

  // 反证一：查不到的精灵 ⇒ 如实说，不许编
  const unknown = await ask('不存在的精灵用什么性格好？');
  assert.ok(!/抬 \+20%/.test(String(unknown.text)), '查不到就不该给建议');
  // 反证二：只有一个个体时不许"比一比"
  const one = await ask('皇家狮鹫这两个个体差在哪？');
  assert.match(String(one.text), /看到 1 个个体|至少要有两个/, `凑不齐要如实说：${one.text}`);
});

test('⑪ 浏览器安全：数据用生成常量，模块里不许静态 import node:*，生成物与源逐值一致', () => {
  const talentSrc = readFileSync(new URL('../src/coach/talent.js', import.meta.url), 'utf8');
  const adviceSrc = readFileSync(new URL('../src/coach/nature-advice.js', import.meta.url), 'utf8');
  for (const [name, src] of [['talent.js', talentSrc], ['nature-advice.js', adviceSrc]]) {
    assert.doesNotMatch(src, /from 'node:/, `${name} 不许静态 import node:*（浏览器整条链会静默断掉）`);
  }
  assert.match(adviceSrc, /import\('node:fs'\)/, '种族值那一段要用**动态** import（浏览器里不执行）');
  // 生成物 vs 源：逐值对拍（改了 JSON 不重新生成 ⇒ 必红）
  const generated = readFileSync(new URL('../src/coach/natures-data.js', import.meta.url), 'utf8');
  for (const row of natures()) {
    assert.ok(generated.includes(`name: '${row.name}'`) && generated.includes(`up: '${row.up}'`)
      && generated.includes(`down: '${row.down}'`), `生成物里缺/错了「${row.name}」`);
  }
  const names = readFileSync(new URL('../src/coach/pet-names-data.js', import.meta.url), 'utf8');
  const sample = rows.filter((row) => row.name && row.stats).slice(0, 5);
  for (const row of sample) {
    assert.ok(names.includes(`['${row.name}', '${row.pet_id}']`), `名字表里缺「${row.name}」`);
  }
  assert.match(generated, /自动生成，\*\*不要手改\*\*/, '生成物必须写明"不要手改"');
  assert.match(names, /自动生成，\*\*不要手改\*\*/);
});

