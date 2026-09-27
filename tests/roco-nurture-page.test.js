/**
 * 判据：**「培养」页（RC-306）已退役** —— 加点那一整套从产品里拿掉。
 *
 * 人类 2026-09-27 原话：「不要，按照洛手的机制来，根本没有这些，不要了。」
 * （此前一轮还只是"说清档位 + 入口改道"，这一轮整页退役。）
 *
 * 退役的四件事（页面 / 文案 / 判据 / 存档），逐条钉住：
 *   ① **页面文件删掉**（`nurture.html` / `nurture.js` / `nurture.css`），静态清单里也去掉；
 *   ② **旧 URL 不落 404**：`/nurture.html` 与 `/nurture` 302 到 `/box.html`；
 *   ③ **没有任何页面再链到它**（两个入口按钮 `#nav-nurture` / `#xy-nav-nurture` 一起删）；
 *   ④ **玩家可见文案里不再提供那一套**（训练点 / 培养格 / 加点）——「没有加点」这种
 *      如实否定句放行（那正是我们现在要说的话）。
 *
 * 起草时的**反证**：把 `RETIRED_PAGES` 的映射换掉、把老入口写法塞回去、
 * 拿旧文案喂 ④ 的尺子 —— 同一条判据都必须报红（判据不能是空的）。
 *
 * 用法：`node --test tests/roco-nurture-page.test.js`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer, PAGE_ALIASES, RETIRED_PAGES, publicAssets} from '../src/server/index.js';
import {localParametricFact} from '../src/coach/runtime.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 玩家可见文案的宿主（会讲"培养"的那几处）。 */
const COPY_FILES = ['src/client/index.html', 'src/client/box.html', 'src/client/roco.html',
  'src/client/xiaoya.html', 'src/client/app.js', 'src/client/box.js', 'src/client/box-drawer.js'];
/** 那一套词（出现即红）——「没有加点」这种否定句由 `trainingSurfaceHits` 放行。 */
const TRAINING_WORDS = ['训练点', '培养格', '加点'];
/** 如实否定的形状。 */
const NEGATION = /没有加点|不加点/;

/** HTML 的文本节点（玩家在页面上真的读到的字）。 */
function htmlTextNodes(source) {
  return [...String(source).replace(/<!--[\s\S]*?-->/g, '').matchAll(/>([^<>]+)</g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * 一段玩家可见文字里有没有"还在提供加点"的说法（明确否定 ⇒ 放行）。
 * 导出是为了让反证用**同一把尺子**，而不是另写一份。
 */
export function trainingSurfaceHits(text) {
  const hits = [];
  for (const line of String(text ?? '').split('\n')) {
    if (NEGATION.test(line)) continue;
    for (const word of TRAINING_WORDS) if (line.includes(word)) hits.push(`${word}：${line.trim().slice(0, 60)}`);
  }
  return hits;
}

test('① 页面文件与静态清单：培养页整页退役', () => {
  for (const rel of ['src/client/nurture.html', 'src/client/nurture.js', 'src/client/nurture.css']) {
    assert.equal(existsSync(join(ROOT, rel)), false, `${rel} 应当已删除（加点那一档整页退役）`);
    assert.equal(publicAssets.has(rel), false, `${rel} 不许留在静态白名单里`);
  }
  assert.equal(Object.hasOwn(PAGE_ALIASES, 'nurture.html'), false, '短路径表里不该再有培养页');
  // 白名单里剩下的每个页面文件都真的在（退役页走 302，不在白名单里）
  for (const asset of publicAssets) {
    if (asset.endsWith('.html')) assert.ok(existsSync(join(ROOT, asset)), `${asset} 在白名单里但文件不在`);
  }
});

test('② 旧 URL 302 到盒子页（书签不许落 404）', async () => {
  assert.equal(RETIRED_PAGES['nurture.html'], '/box.html', '退役页的落点是盒子页');
  assert.equal(RETIRED_PAGES.nurture, '/box.html', '不带 .html 的短地址同样要退');
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (const url of ['nurture.html', 'nurture']) {
      const res = await fetch(base + url, {redirect: 'manual'});
      assert.equal(res.status, 302, `/${url} 应当 302（实际 ${res.status}）`);
      assert.equal(res.headers.get('location'), '/box.html', `/${url} 的落点`);
    }
    const box = await fetch(`${base}box.html`);
    assert.equal(box.status, 200, '落点 /box.html 必须真的能打开');
    // 反证：换一个落点，上面那两条就必须报错
    const wrong = {...RETIRED_PAGES, 'nurture.html': '/roco.html'};
    assert.notEqual(wrong['nurture.html'], '/box.html', '（反证）换落点会被上面抓住');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('③ 没有任何页面再链到培养页（两个入口按钮一起删）', () => {
  const htmls = ['src/client/index.html', 'src/client/roco.html', 'src/client/xiaoya.html',
    'src/client/box.html', 'src/client/workshop.html', 'src/client/connect.html'];
  for (const rel of htmls) {
    const html = read(rel);
    assert.doesNotMatch(html, /href="[^"]*nurture/, `${rel} 里还有指向培养页的链接`);
    assert.doesNotMatch(html, /id="(?:nav|xy-nav)-nurture"/, `${rel} 里还有那个入口按钮`);
  }
  for (const rel of ['src/client/roco.js', 'src/client/xiaoya.js', 'src/client/app.js', 'src/client/box.js']) {
    assert.doesNotMatch(read(rel), /nurture\.html/, `${rel} 里还有指向培养页的跳转`);
  }
  // 反证：老的入口写法喂给同两条正则，必须命中
  const old = '<a class="nav-btn" id="nav-nurture" href="nurture.html">✦ 练习养成（三只）</a>';
  assert.ok(/href="[^"]*nurture/.test(old) && /id="(?:nav|xy-nav)-nurture"/.test(old),
    '（反证）老的入口写法会被上面两条抓住');
});

test('④ 玩家可见文案里不再提供加点（"没有加点"这种如实否定句放行）', () => {
  const bad = [];
  for (const rel of COPY_FILES) {
    const source = read(rel);
    const lines = rel.endsWith('.html') ? htmlTextNodes(source)
      : source.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line));
    for (const line of lines) for (const hit of trainingSurfaceHits(line)) bad.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(bad, [], `玩家可见文案里还在讲加点/训练点/培养格：\n${bad.join('\n')}`);
  // 页面要**主动说清**这件事（不能只是"没提"）
  const camp = read('src/client/index.html');
  assert.match(camp, /没有加点/, '营地页要说清"这一版没有加点"');
  assert.match(camp, /我的盒子|box\.html/, '并指出培养在哪做');
  // 反证：旧文案两个词都要被抓到；如实否定句必须放行
  assert.equal(trainingSurfaceHits('培养格 3/8 · 训练点 2').length, 2, '（反证）旧文案要被抓到');
  assert.deepEqual(trainingSurfaceHits('这一版没有加点：培养就是改性格与天分'), [],
    '（反证）如实否定句必须放行（否则页面没法解释这件事）');
});

test('⑤ 教练那一侧：加点问句本地答"没有加点"，一个旧数都不报', () => {
  const camp = {mode: 'camp', profile: {growth: {pets: {fox: {points: {hp: 1}}}, tokens: 3}}};
  const mobile = {mode: 'camp', profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫'}], lineup: []}};
  for (const [label, context] of [['营地', camp], ['手游', mobile]]) {
    for (const question of ['加点收益是多少？', '每点敏捷加多少速度？', '培养哪个属性最能改变先手？']) {
      const answer = localParametricFact(question, context);
      assert.ok(answer && typeof answer.text === 'string', `${label}「${question}」要有本地答案`);
      assert.match(answer.text, /没有加点/, `${label}「${question}」要直说没有加点：${answer.text}`);
      assert.doesNotMatch(answer.text, /培养格|训练点 ?\d|\+12 生命|\+4 攻击|\+3 速度/,
        `${label}「${question}」不许再报旧口径的数：${answer.text}`);
    }
  }
});
