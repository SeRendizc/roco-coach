// 「红绿标记必须来自引擎，而不是模板里的设计稿静态值」判据（2026-09-25）。
//
// **人类报的现象**：「那个优势劣势（红绿色）不是实时计算的？我上一回合时优势的突然到下个回合就
// 劣势了，而且显示还是绿色的优势啊」。查下来的根因**不在算法，在模板**：
// `src/client/roco.html` 直接写死了设计稿的值 ——
//   · 技能格与更换屏的 `<span class="b3-rel" data-b3-rel="up|down">`（绿▲/红▼）；
//   · 伤害格 `<div class="b3-dmg b3-dmg--up">预期伤害 214</div>`（绿字）。
// JS **只写 `data-b3-dmg-kind`**（CSS 认的却是 class），而更换屏的三角**从来没人写** ——
// 于是那一格永远显示设计稿的「绿色优势」。
//
// 判据（每一条配必红反证）：
//   ① 模板里**不许**再出现静态 `data-b3-rel="up|down"`（`none` 也是断言「无影响」，同样不许）；
//   ② 模板里**不许**再出现 `b3-dmg--up|--down` 静态 class；
//   ③ CSS 必须认 **JS 真正写的那一份**（`[data-b3-dmg-kind=…]`），且给 `unknown` 一条「不画」的规则；
//   ④ 客户端必须**从 `sample.multiplier` 推**三角与颜色，并把更换屏显式写成 `unknown`；
//   ⑤ 结构完好：每个 `.b3-rel` 仍带三个 SVG（删断言不许把标记本身删坏）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const HTML = readFileSync(new URL('../src/client/roco.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/client/battle-v3.css', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
void ROOT;

test('① 模板里不许再有静态的克制断言（up/down/none 都算断言）', () => {
  const offenders = [...HTML.matchAll(/data-b3-rel="(up|down|none)"/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `模板里还有 ${offenders.length} 处写死的克制标记：${offenders.slice(0, 3)}`);
  const unknown = [...HTML.matchAll(/data-b3-rel="unknown"/g)].length;
  assert.ok(unknown >= 10, `模板里的克制标记应当都改成 unknown（实际 ${unknown} 处）`);
  // 反证：探测同一形状的坏串必须命中
  const probe = (text) => [...text.matchAll(/data-b3-rel="(up|down|none)"/g)].length;
  assert.equal(probe('<span data-b3-rel="up">'), 1, '探测器本身必须能红');
  assert.equal(probe(HTML), 0);
});

test('② 模板里不许再有静态的绿/红伤害（CSS 认的是 data 属性，不是 class）', () => {
  for (const cls of ['b3-dmg--up', 'b3-dmg--down']) {
    assert.ok(!HTML.includes(cls), `模板里还有写死的 ${cls}（设计稿的绿/红）`);
  }
  // 反证：坏串必须被同一条探测抓住
  const probe = (text) => ['b3-dmg--up', 'b3-dmg--down'].filter((c) => text.includes(c));
  assert.deepEqual(probe('<div class="b3-dmg b3-dmg--up">'), ['b3-dmg--up']);
  assert.deepEqual(probe(HTML), []);
});

test('③ CSS 认 JS 写的那一份，并给 unknown 一条"不画"规则', () => {
  assert.match(CSS, /\.b3-dmg\[data-b3-dmg-kind="up"\]\{color:var\(--b3-grn\)\}/,
    'CSS 必须认 data-b3-dmg-kind="up"（JS 真正写的那一份）');
  assert.match(CSS, /\.b3-dmg\[data-b3-dmg-kind="down"\]\{color:var\(--b3-red\)\}/, 'down 同理');
  assert.match(CSS, /\.b3-rel\[data-b3-rel="unknown"\] svg\{display:none\}/,
    'unknown 必须"一个都不画"（白圈的含义是"无影响"，拿它兜底就是替引擎宣称没算过的事）');
});

test('④ 客户端从 sample.multiplier 推三角与颜色；更换屏显式 unknown', () => {
  assert.match(CLIENT, /const mult = Number\.isFinite\(Number\(sample\?\.multiplier\)\) \? Number\(sample\.multiplier\) : null/,
    '倍率只能来自引擎给的 sample.multiplier');
  assert.match(CLIENT, /const relWord = mult === null \? 'unknown' : mult > 1 \? 'up' : mult < 1 \? 'down' : 'none'/,
    'up/down/none 的判定必须写在这一处（拿不到就是 unknown）');
  // ⚠ 2026-09-29 U05 **改钉**（旧断言原文留档，**别删**）：
  //     assert.match(CLIENT, /const mark = cell\.querySelector\('\[data-b3-rel\]'\);\s*\n\s*if \(mark\) mark\.dataset\.b3Rel = 'unknown'/,
  //       '更换屏的三角必须显式写成 unknown（不清掉就会一直显示设计稿的值）');
  // 为什么改（依据：用户 2026-09-29 截图 5/6 的 U05 口径 + review-2026-09-28/product-reset-2026-09-29/README.md U05）：
  //   旧口径是「承伤倍率拿不到 ⇒ 一律 unknown」。而用户报的正是「换精灵后克制/被克制标记**丢失**」
  //   —— "一律 unknown"就是那个"丢失"本身：设计稿里写死的值确实被清掉了，但**真的倍率一个都没补**。
  //   现在口径定了：换人候选 = **承伤向**相性（对手属性各当一次攻击系，取最坏那一格），
  //   数据来自 `src/client/type-affinity.js`（由冻结真值 `types.json` 生成，逐格对账 2160/2160）。
  //   所以这一格**必须**写活值，只允许「防御组合没登记」时落回 unknown。
  //   同一段里技能格那条**进攻向**倍率（引擎 samples）一个字没动 —— 两者不许混用。
  assert.match(CLIENT, /const REL_MARK = Object\.freeze\(\{threat: 'down', resist: 'up', neutral: 'none', unknown: 'unknown'\}\)/,
    '承伤相性的方向词只在一处映射成 CSS 认的 up/down/none（避免两套口径）');
  assert.match(CLIENT, /const mark = cell\.querySelector\('\[data-b3-rel\]'\);\s*\n\s*if \(mark\) \{\s*\n\s*mark\.dataset\.b3Rel = REL_MARK\[affinity\.direction\] \?\? 'unknown'/,
    '更换屏的三角必须按**现算**的承伤相性写（只有组合未登记才落回 unknown，不许一律 unknown）');
  // 反证：这条新断言必须能红 —— 拿旧写法（一律 unknown）喂给它，必须不匹配。
  assert.equal(/mark\.dataset\.b3Rel = REL_MARK\[affinity\.direction\]/.test("if (mark) mark.dataset.b3Rel = 'unknown'"), false,
    '反证：新探测器对"一律 unknown"的旧写法必须为假');
  // 反证：把相性函数从源码里抽掉，新断言也必须红（防止它变成"只要写了 REL_MARK 就绿"的摆设）。
  assert.equal(
    /const mark = cell\.querySelector\('\[data-b3-rel\]'\);\s*\n\s*if \(mark\) \{\s*\n\s*mark\.dataset\.b3Rel = REL_MARK\[affinity\.direction\] \?\? 'unknown'/
      .test(CLIENT.replaceAll('incomingAffinity', 'REMOVED')),
    true,
    '说明：这条钉的是"写法"，不含函数名 —— 函数是否真的被调用由 tests/roco-client-type-affinity.test.js 与真机读数负责');
  // 反证：探测器对准"没有这段"的源码必须为假
  const probe = (src) => /const relWord = mult === null/.test(src);
  assert.equal(probe('const x = 1;'), false, '探测器本身必须能红');
  assert.equal(probe(CLIENT), true);
});

test('⑤ 结构完好：每个 .b3-rel 仍带三个 SVG（删断言不许删坏标记）', () => {
  // 属性顺序/换行都可能不同，所以按"带 class="b3-rel" 的 span"匹配（`\s+` 允许换行）。
  const marks = [...HTML.matchAll(/<span\s+class="b3-rel"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  // 14 处 `data-b3-rel` 里只有 9 处是 `<span class="b3-rel">`（另外 5 处在行容器上，
  // 那是设计稿的另一份拷贝；CSS 只认 span 这一份，但两份都不许再写死）。
  assert.ok(marks.length >= 9, `克制标记（span）应当还在（实际 ${marks.length} 处）`);
  for (const [index, inner] of marks.entries()) {
    for (const cls of ['b3-rel-up', 'b3-rel-down', 'b3-rel-none']) {
      assert.ok(inner.includes(cls), `第 ${index + 1} 个标记缺 ${cls}（三个 SVG 是"只改一个属性"的前提）`);
    }
  }
});

// ── 两条真机审计问题（2026-09-27）的静态判据 ──────────────────────────────────
test('训练场页给教练的请求必须带局面身份；一次行动在飞时不许再点（审计高 2/高 3）', () => {
  const src = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  // 高 2：这两条 `/api/coach` 原来**从不发 stateToken** ⇒ 服务端缓存 key 退化成「同一句话」，
  // 局面换了也命中上一版答案。现在必须带一个**会随局面变**的身份。
  // 只数**真的发请求**的地方（`api('/api/coach'`），每条后面 500 字内必须出现 stateToken。
  // 第一版按字符串出现次数数，把注释里的 `/api/coach` 也算成了请求（10 vs 2），判据自己错了。
  const sites = [...src.matchAll(/api\('\/api\/coach'/g)].map((m) => m.index);
  assert.ok(sites.length >= 2, `这一页至少有两条真的教练请求（实际 ${sites.length}）`);
  for (const at of sites) {
    const body = src.slice(at, at + 500);
    assert.match(body, /stateToken:\s*coachStateToken\(\)/,
      `这条教练请求没带局面身份（位置 ${at}）：${body.slice(0, 120)}`);
  }
  assert.match(src, /function coachStateToken\(\)/, '身份要有唯一一份实现');
  assert.match(src, /battleId[\s\S]{0,80}state_version/, '身份要含对局号与引擎给的局面版本');
  // 高 3：双击技能卡原来会**真的打两回合**（审计实测 140–180ms 内两下 = 两回合）
  assert.match(src, /if \(state\.actionInFlight\) return;/, '一次行动在飞时必须忽略第二次点击');
  assert.match(src, /state\.actionInFlight = true;/, '要真的置位');
  assert.match(src, /finally \{[\s\S]{0,40}state\.actionInFlight = false;/, '无论成败都要复位（否则行动被永久锁死）');
  // 服务端那半：出招要带上"我看到的局面版本"，服务端才能做版本 CAS（审计高 3 的后半）
  assert.match(src, /battle_id: state\.battleId, action,[\s\S]{0,80}state_version: state\.view\?\.state_version/,
    '出招必须带上局面版本（否则并发那一半堵不住）');
});

test('发消息时不许把玩家第二条弄丢（审计高 11）：飞行中禁发、输入框不清空', () => {
  // ⚠ 2026-09-30 **改钉**（task-13 甲④-1：`#companion-card` 退役，小芽只剩 `xiaoya.js` 一套实现）。
  // 旧断言（原文留档，别再改回来）：
  //   const src = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  //   const html = readFileSync(new URL('../src/client/roco.html', import.meta.url), 'utf8');
  //   assert.match(html, /id="say-send"/, '发送按钮要有 id（飞行时禁用它）');
  //   assert.match(src, /if \(state\.coachInFlight\) \{/, '在飞时不发新请求');
  //   assert.match(src, /sayStatus\('上一条还在查/, '要说一句人话，而不是把第二次提交吞掉');
  //   assert.match(src, /state\.coachInFlight = true;/, '要真的置位');
  //   assert.match(src, /finally \{[\s\S]{0,120}state\.coachInFlight = false;/, '无论成败都要复位');
  //   // 反证：清空输入框必须发生在"确定要发"之后 —— 不能先清空再判断
  //   const submitAt = src.indexOf("$('say-form').addEventListener('submit'");
  //   const clearAt = src.indexOf("$('say-input').value = '';", submitAt);
  //   const guardAt = src.indexOf('if (state.coachInFlight) {', submitAt);
  //   assert.ok(guardAt > submitAt && clearAt > guardAt, '守卫必须排在清空输入框之前');
  // 为什么改：这些 id / 变量名属于**已退役的旧面板**（`#say-send` / `state.coachInFlight` 现在只在
  // `roco.js` 的死绑定里）。**审计高 11 的意图一个字没松**：在飞时不许把玩家第二条吞掉，
  // 而且要**说一句人话**、**先判断再清空**。新钉指向**现在还活着的那一处**（浮层的表单 + `state.asking`）：
  const src = readFileSync(new URL('../src/client/xiaoya.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/client/roco.html', import.meta.url), 'utf8');
  assert.match(src, /id="xiaoya-send"/, '发送按钮要有 id（飞行时禁用它）——现在是浮层那一个');
  assert.doesNotMatch(html, /id="say-send"/, '旧面板的发送按钮不许回来（它已经退役）');
  assert.match(src, /if \(state\.asking\) \{/, '在飞时不发新请求');
  assert.match(src, /上一条还在查，等它出来我马上答这一条/, '要说一句人话，而不是把第二次提交吞掉');
  assert.match(src, /state\.asking = true;/, '要真的置位');
  assert.match(src, /finally \{[\s\S]{0,200}state\.asking = false;/, '无论成败都要复位（否则再也发不出去）');
  // 反证：清空输入框必须发生在"确定要发"之后 —— 不能先清空再判断
  const submitAt = src.indexOf("form?.addEventListener('submit'");
  const clearAt = src.indexOf("input.value = '';", submitAt);
  const guardAt = src.indexOf('if (state.asking) {', submitAt);
  assert.ok(submitAt > -1 && guardAt > submitAt && clearAt > guardAt,
    '守卫必须排在清空输入框之前（先清空就会丢掉玩家打的那句话）');
});

