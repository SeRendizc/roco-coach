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
    // ⚠ 2026-09-27 改钉：长处那一侧随突破长（初始 +10%、每突破 +2%、满 +20%），
    // 这里算的是**零突破下界** ⇒ 正文写 +10%。出处行里会把整条阶梯写出来。
    assert.match(row.text, /抬 \+10%/, `要说清换来了什么：${row.text}`);
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
  assert.match(String(advice.text), /速度抬 \+10%/, `要说清换来了什么（零突破下界）：${advice.text}`);
  assert.match(String(advice.text), /满突破 \+20%|初始 \+10%/, '出处行要把突破阶梯说出来');
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
  assert.ok(!/抬 \+\d+%/.test(String(unknown.text)), '查不到就不该给建议');
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

test('⑫ 同名**不同种**不许当成"两个个体"比（真机抓到的错）', async () => {
  // 现场：名单里两只「棋契陛下」是**两个不同物种**（pet_000556 / pet_000575），
  // 而这一支回答的是"**同一只**的两个个体差在哪"。`compareIndividuals` 按一个 race 给两边算面板
  // ⇒ 拿两个物种套同一份种族值比出来的表没有意义。这一档必须 fail closed 并把原因说清。
  const context = {profile: {pets: [
    {name: '棋契陛下', species_id: 'pet_000556', talent: {hp: 10, atk: 3, def: 1, spa: 7, spd: 3, spe: 10}, nature: '开朗'},
    {name: '棋契陛下', species_id: 'pet_000575', talent: {hp: 1, atk: 10, def: 7, spa: 3, spd: 10, spe: 1}, nature: '固执'},
  ]}};
  const answer = await natureLocalAnswer({message: '棋契陛下这两个个体差在哪？', context});
  assert.ok(answer, '这一句要认出来（否则会掉到别的分支）');
  assert.match(String(answer.text), /不是同一个物种/, String(answer.text));
  assert.match(String(answer.text), /pet_000556/, '要把两个物种 id 摆出来');
  assert.match(String(answer.text), /pet_000575/);
  assert.doesNotMatch(String(answer.text), /第一个个体在/, '不许给出那种"比过了"的表');
  // 反证：**同种**的两个个体要照旧比得出来（不能因为上面这条把功能关掉）
  const sameSpecies = {profile: {pets: [
    {name: '喵喵', species_id: 'pet_000001', talent: {hp: 10, atk: 3, def: 1, spa: 7, spd: 3, spe: 10}, nature: '开朗'},
    {name: '喵喵', species_id: 'pet_000001', talent: {hp: 1, atk: 10, def: 7, spa: 3, spd: 10, spe: 1}, nature: '固执'},
  ]}};
  const ok = await natureLocalAnswer({message: '喵喵这两个个体差在哪？', context: sameSpecies});
  assert.match(String(ok.text), /第一个个体在/, `同种要照旧比：${ok?.text}`);
});

// ── 2026-09-30（半成品排查 #4：**缺值当默认值** ✗）─────────────────────────────
// 旧写法（**逐字留档，改钉不删**）：
//   `if (!one.talent || STAT_KEYS.every((stat) => !Number(one.talent?.[stat]))) {`
//     `caveats.push(`${label}的天分是 0（缺数值时的占位）⇒ 天分那一半比不出高低`); }`
//   `const pa = panelOf({race, talent: a.talent, nature: a.nature}).panel;`
// ⇒ 缺的天分**照 0 进了面板计算**：结论看着有依据，其实是**用一个假数算出来的** ✗
// 现在：缺的那一半**不参与计算**（panelOf 收到 null）⇒ 只比真有的那一半，且**正文与 caveats 都明说** ✓
test('⑥b 缺天分不许当 0：那一半不参与计算，且正文与依据都要说明"不含天分"（反证）', async () => {
  const race = {hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100};
  const talent = {hp: 10, atk: 20, def: 0, spa: 0, spd: 0, spe: 5};
  // ① 有值：两半都参与（天分的差会体现在 atk 上）
  const full = compareIndividuals({race, a: {nature: '开朗', talent}, b: {nature: '胆小', talent: {...talent, atk: 0, spe: 20}}});
  assert.deepEqual(full.compared, ['天分', '性格'], `两半都有值时要都算：${JSON.stringify(full.compared)}`);
  const atkWithTalent = full.diff.atk;
  // ② 缺天分：那一半**不参与** ⇒ atk 的差只剩性格那部分（比有值时小得多），且明说"不含天分"
  const noTalent = compareIndividuals({race, a: {nature: '开朗', talent: null}, b: {nature: '胆小', talent: null}});
  assert.deepEqual(noTalent.compared, ['性格'], `缺天分时只该比性格：${JSON.stringify(noTalent.compared)}`);
  assert.ok(Math.abs(noTalent.diff.atk) < Math.abs(atkWithTalent), `缺天分时 atk 的差里不许还留着天分那部分（${noTalent.diff.atk} vs ${atkWithTalent}）`);
  assert.ok(noTalent.caveats.some((row) => row.includes('不含天分')), `依据里要明说"不含天分"：${noTalent.caveats}`);
  // 旧口径逐字是「天分是 0（缺数值时的占位）⇒ 天分那一半比不出高低」——**这句不许再出现** ✓
  // （新口径里出现的「不是按 0 算」是**说明**，不算旧口径 ✓）
  assert.doesNotMatch(noTalent.caveats.join(' '), /天分是 0|缺数值时的占位/, '旧口径「天分是 0（占位）」不许再出现');
  assert.match(noTalent.text, /只比了性格这一半/, `正文要自己说清只比了哪一半：${noTalent.text}`);
  // ③ 反证：两半都有值时**不许**出现"只比了…"这种降级说法
  assert.doesNotMatch(full.text, /只比了/, `两半都有值时不该降级：${full.text}`);
  // ④ 两半都缺 ⇒ 只比种族值，且两条 caveat 都在
  const none = compareIndividuals({race, a: {nature: null, talent: null}, b: {nature: null, talent: null}});
  assert.deepEqual(none.compared, [], `两半都缺时不该有任一参与：${JSON.stringify(none.compared)}`);
  assert.equal(none.caveats.length, 2, `两半都缺时两条都要说：${none.caveats}`);
});

// ── 2026-09-30（Lead 裁决口径 (a)：**缺天分⇒结论照给，但"按 0 计入"必须落在每一条结论的正文**）──
// 背景：`talent.js:462` 的 `?? 0`（缺天分当 0 进公式）**不改成"不参与"**（那会打红 6 条契约、
// 而且"给不出结论"比"给结论+明说偏低"更糟 ✗）⇒ 改成**把这句写进正文** ✓。
// **两态都要钉**（Lead 的硬要求）：缺 ⇒ 必有 ✓ · 齐 ⇒ **必无**（否则就是"无条件挂免责" ✗）
test('⑥c 缺天分⇒每条结论正文都要有"按 0 计入"；天分齐⇒一个字都不许有（两态反证）', async () => {
  const {explainNature, adviceFor, compareIndividuals} = await import('../src/coach/nature-advice.js');
  const race = {hp: 120, atk: 100, def: 90, spa: 80, spd: 80, spe: 60};
  const talent = {hp: 10, atk: 20, def: 0, spa: 5, spd: 5, spe: 3};
  const NOTE = /按 0 计入/;
  const conclusions = (t) => [
    ['explainNature', explainNature({race, talent: t, nature: '开朗'}).text],
    ['adviceFor', adviceFor({race, talent: t, priority: ['spe'], limit: 2}).rows[0].text],
    ['compareIndividuals', compareIndividuals({race, a: {nature: '开朗', talent: t}, b: {nature: '胆小', talent: t}}).text],
  ];
  for (const [name, text] of conclusions(talent)) {
    assert.doesNotMatch(text, NOTE, `天分齐全时「${name}」正文里不许出现免责句：${text}`);
  }
  for (const [name, text] of conclusions(null)) {
    assert.match(text, NOTE, `缺天分时「${name}」正文里必须写清"按 0 计入"：${text}`);
  }
});
