// 「X 的面板是多少」判据（2026-09-27 接）：人类点名的四层**得问得出来**。
//
// 背景：人类说「应该做种族和个体值、性格和资质就够吧？」—— 四层都建了，但真机实测问「喵喵的面板是多少？」
// 答的是「这条我没依据，换个说法或点名一只精灵。」这一组钉住新的出口：
//   · 数字**全部现算**（`panelOf`，60 级 / 零突破 / 天分与性格缺就按 0 与中性并**说清**）；
//   · 上下文里有这个个体（带天分/性格）时**用它的**，并在正文里说明用了什么；
//   · 查不到就如实说查不到，**不拿别的数凑**；
//   · 反证：面板问句不许把「X 的种族值是多少」那一路（`codex-fact`）抢走。
import test from 'node:test';
import assert from 'node:assert/strict';

import {buildContext, policyFor, runCoach, localProvider} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {panelAsk, panelLocalAnswer, raceOf} from '../src/coach/nature-advice.js';
import {panelOf} from '../src/coach/talent.js';

const context = (message, profile = {pets: []}) => buildContext(null, profile, null, null, 'meadow', message);

async function ask(question, profile = {pets: []}) {
  const answer = await runCoach({message: question, role: 'auto', context: context(question, profile),
    memory: freshMemory(), provider: localProvider});
  return {answer, text: String(answer.text)};
}

test('① 「X 的面板是多少」要答得出六维面板：数字现算、按 60 级、缺的假设说清', async () => {
  const question = '喵喵的面板是多少？';
  assert.equal(panelAsk(question), true, '这一句要认出来');
  const {answer, text} = await ask(question);
  const layer = await raceOf('喵喵');
  assert.ok(layer, '图鉴层里要有喵喵');
  // 期望值**现算**（不写死）：60 级、零突破、天分按 0、性格按中性
  const panel = panelOf({race: layer.race, talent: null, nature: null, scope: 'pvp', level: 60,
    breakthrough: 0}).panel;
  const names = {hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'};
  for (const [stat, label] of Object.entries(names)) {
    assert.match(text, new RegExp(`${label} ${panel[stat]}`), `${label} 应等于现算值 ${panel[stat]}：${text}`);
  }
  assert.match(text, /60 级/, '要说清是 60 级那一档');
  assert.match(text, /天分按 0/, '没拿到天分要说清按 0 计（面板偏低）');
  assert.match(text, /性格按中性/, '没拿到性格要说清按中性算');
  assert.match(text, /零突破/, '要说清是零突破下界（满突破那一档是 +20%）');
  assert.equal(answer.agentStop, 'policy-fact-local', '纯事实路径收口（0 次模型调用）');
});

test('② 上下文里有这个个体（带天分/性格）就用它的，并在正文里说明', async () => {
  const layer = await raceOf('喵喵');
  const talent = {hp: 10, atk: 9, def: 8, spa: 7, spd: 6, spe: 10};
  const question = '喵喵的面板是多少？';
  // ⚠ 这里带的来源标记要与**服务端真正补上去的那一份**一致（个体层掷出来的值就是 rolled）——
  // 不带标记的话"建模掷点"那句提示不会出现，判据就会误红（第一版就是这么错的）。
  const {text} = await ask(question, {pets: [{id: 'own-0001', species_id: layer.pet_id, name: '喵喵',
    talent, nature: '开朗', talent_source: 'rolled（原版随机生成；种子化掷点）',
    nature_source: 'rolled（原版抓到时随机生成）'}]});
  const panel = panelOf({race: layer.race, talent, nature: '开朗', scope: 'pvp', level: 60,
    breakthrough: 0}).panel;
  assert.match(text, new RegExp(`速度 ${panel.spe}`), `速度应等于带天分与性格的现算值 ${panel.spe}：${text}`);
  assert.match(text, /天分用你这一只的/, '要说清用的是这一只的天分');
  assert.match(text, /性格「开朗」/, '要说清用的是哪个性格');
  // ⚠ 用了建模值就必须说清"这一份本身不是游戏里的真值"：数据集里 talent/nature 是 null，
  // 值由个体层种子化掷点生成 —— 不说就等于把建模值当实测值端给玩家。
  assert.match(text, /建模掷点/, `用了掷点值就要标出来：${text}`);
  // 反证：这一份必须与"天分 0 + 中性"不同（否则说明个体根本没被用上）
  const neutral = panelOf({race: layer.race, talent: null, nature: null, scope: 'pvp', level: 60,
    breakthrough: 0}).panel;
  assert.notEqual(panel.spe, neutral.spe, '前提：带上天分后的速度真的会变（否则这条判据没有牙）');
  assert.doesNotMatch(text, new RegExp(`速度 ${neutral.spe}\\b`), '不许再给中性那一个数');
});

test('②b 页面自己给的天分/性格（带 dataset 来源）**不许**被说成"建模掷点"', async () => {
  const layer = await raceOf('喵喵');
  const talent = {hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10};
  const text = String((await panelLocalAnswer('喵喵的面板是多少？',
    {individual: {talent, nature: '开朗', talent_source: 'dataset', nature_source: 'dataset'}})).text);
  assert.match(text, /天分用你这一只的/, text);
  assert.doesNotMatch(text, /建模掷点/, `数据集里的真值不许被标成掷点：${text}`);
  assert.ok(layer, '前提：喵喵在图鉴层里');
});

test('③ 查不到/认不出：不许给面板数字（要么如实说查不到，要么干脆不认这一句）', async () => {
  // 编出来的名字**根本不进**这一支（`panelAsk` 要求句子里有一个真的精灵名）—— 返回 null 是对的。
  const madeUp = await panelLocalAnswer('不存在的精灵名啊的面板是多少？', {});
  assert.equal(madeUp, null, '认不出的名字不该被当成面板问句（否则会拿别的数凑）');
  // 真走一遍：正文里不许出现任何"生命 N"式的面板读数
  const {text} = await ask('不存在的精灵名啊的面板是多少？');
  assert.doesNotMatch(text, /生命 \d+/, `不许给面板数字：${text}`);
  // 名字在名字表里、但图鉴层查不到种族值那一档：如实说查不到（这一支直接调，绕开名字识别）
  const layerMiss = await panelLocalAnswer('喵喵的面板是多少？', {});
  assert.ok(layerMiss, '正常的名字要答得出来（上面 ① 已逐项核对）');
});

test('⑤ 同名多形态：**不许挑第一只**算面板（与图鉴问句同一口径）', async () => {
  // 现场：`raceOf` 原来是 `rows.find(name)` —— 同名多形态（钻石蜗 6 种、鸭吉吉国王 6 种）会**静默取第一只**，
  // 与图鉴问句的"不替你挑一只"自相矛盾。现在按名字命中多条时返回 `ambiguous` + 候选。
  const amb = await raceOf('钻石蜗');
  assert.equal(amb?.ambiguous, true, '同名多形态要标 ambiguous');
  assert.ok(amb.matches.length >= 2, `候选要列出来（实际 ${amb.matches.length}）`);
  const {text} = await ask('钻石蜗的面板是多少？');
  assert.match(text, /对应 \d+ 只不同形态/, text);
  assert.match(text, /说一个 pet_id/, '要请玩家挑一只（不替他挑）');
  assert.doesNotMatch(text, /生命 \d+ \/ 物攻/, `多形态时不许给单一套面板：${text}`);
  // 反证：给了 pet_id 就要答得出来（否则上面那条只是"什么都不答"）
  const one = await raceOf(amb.matches[0].pet_id);
  assert.ok(one && !one.ambiguous && one.race?.hp, '按 pet_id 要能取到那一只的种族值');
});

test('④ 反证：面板问句不许抢走图鉴字段那一路（「X 的种族值」仍是 codex-fact）', () => {
  const facts = '喵喵的种族值是多少？';
  assert.equal(panelAsk(facts), false, '「种族值」不是面板问句');
  assert.equal(policyFor(facts, context(facts)).reason, 'codex-fact', '那一句的政策不许被面板抢走');
  assert.equal(panelAsk('防御能减伤多少？'), false, '没点名精灵不算面板问句');
  assert.equal(panelAsk('这只面板怎么算？'), false, '没点名精灵也不算（要说清是哪一只）');
  assert.equal(panelAsk('喵喵的面板是多少？'), true);
  assert.equal(panelAsk('寂灭骨龙的面板'), true, '不带"是多少"也认');
});

test('⑥ 正文口径：面板那一串必须写「资质」，且说清默认 5 星、逗号后不留孤空格', async () => {
  // 人类 2026-09-28 拍板：「资质」这个词**要**出现在玩家正文里（原先只写"种族值 + 天分 + 性格"）。
  const text = String((await panelLocalAnswer('喵喵的面板是多少？', {})).text);
  assert.match(text, /面板 = 种族值 \+ 资质 \+ 天分 \+ 性格/, text);
  assert.match(text, /默认 5 星/, '要说清默认按 5 星算');
  assert.match(text, /放大 6 倍/, '要说清资质那一项被放大 6 倍（否则玩家看不懂数为什么这么大）');
  assert.doesNotMatch(text, /[）)] +算的/, `标点后不许留孤零零的空格（排版）：${text}`);
});

// ── 2026-09-29（第三轮要求③）：**能力问句要答"能做什么"，不是"我没依据"** ──────────────
// 背景：真 8765 实测，配队页新问「你能做什么」答的是「这条我没依据，换个说法或点名一只精灵。」
// —— 因为 `companion.js` 的 `fallbackLine()` 里**根本没有"能力问句"这一支**，
// 那个「什么」把它送进了"问事实"的兜底。用户逐字要求：「新问『你能做什么』需回答**可执行能力**」。
test('⑥ 能力问句要有可执行能力这一支，且不许抢走面板/事实问句', async () => {
  for (const q of ['你能做什么', '你会什么', '你有什么功能']) {
    const {text} = await ask(q);
    assert.doesNotMatch(text, /这条我没依据/, `${q} 不该落到"没依据"那条兜底：${text}`);
    assert.match(text, /规则|名单|建议|复盘/, `${q} 要说出**具体能做的事**：${text}`);
  }
  // **反证**：加了这一支之后，面板问句不许被抢走（这是它最容易踩的坑 —— 都在问"什么"）
  const {text: panel} = await ask('喵喵的面板是多少？');
  assert.match(panel, /面板/, '面板问句必须仍然走面板那一路');
  assert.doesNotMatch(panel, /查规则、看你的名单/, '面板问句不许被能力分支吃掉');
  // **反证②**：越界问句仍然走"不擅长"那一支（能力分支不许把它也吃了）
  const {text: code} = await ask('帮我写一段 python 代码');
  assert.match(code, /不擅长|聊游戏/, `越界问句的出口不该变：${code}`);
});

// ── 2026-09-29（第三轮要求③）："怎么办"类兜底**不许断言对局状态** ─────────────────────
// 我先把它写成「现在没有进行中的对局：…」，随后真 8765 逐问实测发现**对局中「我该干什么」也会落到
// `companion`**（而 `现在怎么办`/`下一步该干嘛` 在对局中是 `strategist`）⇒ 那句话在当时是**假话**。
// 这条判据就是钉住"别再做这种没有依据的断言"。
test('⑦ "怎么办"类兜底要给出下一步，且不许声称对局状态', async () => {
  for (const q of ['现在怎么办', '下一步该干嘛', '我该干什么']) {
    const {text} = await ask(q);
    assert.doesNotMatch(text, /这条我没依据/, `${q} 不该落回"没依据"：${text}`);
    assert.doesNotMatch(text, /没有进行中的对局|没有对局|不在对局/,
      `${q} **不许断言对局状态**（对局中它也可能是 companion 路由，那样就是假话）：${text}`);
    // ⚠ 2026-09-29 改钉（同一天，紧跟路由那条）：**旧断言原文留档**：
    //   assert.match(text, /哪一|给你?建议|手上的信息/, `${q} 要说清下一步能给我什么：${text}`);
    // 为什么改：`现在怎么办` 现在**不再走这个兜底**了 —— 它已经进了 strategist 关键词
    //   （`runtime.js` 的路由表补了「怎么办|该干嘛|该干什么|下一步」），无对局时答的是
    //   strategist 那句「开一局之后，我才能按当前生命、能量和队伍比较这一手。」
    //   ⇒ 判据要跟着**行为**走，但上面两条**真不变量一个字没放松**（不许"没依据"、不许断言对局状态）。
    assert.match(text, /哪一|给你?建议|手上的信息|开一局|比较这一手/,
      `${q} 要说清下一步能给我什么：${text}`);
  }
});
