/**
 * 判据：本地 4B 的**输出契约**（人类 2026-09-26 ⑤：「不许输出英语啥的然后正则删除掉」）。
 *
 * 这一条要钉的不是"删得干净"，而是**方向**：
 *   · 契约写在提示词里（要什么格式，说清楚）；
 *   · 拿到输出**按契约校验**；不合格 = 不合格，**不修剪、不救场**，如实降级并单独记账；
 *   · 于是"成功率 / 违规率 / 降级率"是能报出来的数，而不是感觉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseLocalOutput, LOCAL_OUTPUT_CONTRACT, LOCAL_SYSTEM_PROMPT, wrapWithLocalModel}
  from '../src/coach/local-model.js';
import {runCoach, localProvider} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';

const camp = () => ({mode: 'camp', battle: null,
  profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫', types: ['翼系'], stats: {spe: 120}}]}});
const modelReturning = (text) => ({calls: 0, async generate() { this.calls += 1; return {text, total_ms: 7}; }});
const OK = '{"answer":"先看速度线，快的先手。","basis":["材料里的速度档"]}';

test('① 合规输出按契约取值（answer + basis）', () => {
  const result = parseLocalOutput(OK);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.answer, '先看速度线，快的先手。');
  assert.deepEqual(result.value.basis, ['材料里的速度档']);
  // basis 可以缺、可以超量（超量截断 —— 那是**字段边界**，不是改内容）
  assert.deepEqual(parseLocalOutput('{"answer":"行。"}').value.basis, []);
  const many = parseLocalOutput(`{"answer":"行。","basis":${JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `依据${x}`))}}`);
  assert.equal(many.value.basis.length, LOCAL_OUTPUT_CONTRACT.maxBasisItems);
  // 常见的"整段包在代码块里"剥壳，不算修内容
  assert.equal(parseLocalOutput('```json\n' + OK + '\n```').ok, true);
});

test('② 六种不合格各自报出**具体原因**（不是一句"格式不对"）', () => {
  const cases = [
    ['', 'empty-output'],
    ['我建议先看速度。', 'not-json'],
    ['[1,2,3]', 'not-object'],
    ['{"basis":[]}', 'missing-answer'],
    ['{"answer":"   "}', 'missing-answer'],
    ['{"answer":"' + '很'.repeat(LOCAL_OUTPUT_CONTRACT.maxAnswerChars + 1) + '"}', 'answer-too-long'],
    ['{"answer":"先看你 roster_total 里那几只。"}', 'latin-leak'],
    ['{"answer":"先看 hp 就行。"}', 'latin-leak'],
    ['{"answer":"看**速度**就行。"}', 'markdown-leak'],
  ];
  for (const [raw, code] of cases) {
    const result = parseLocalOutput(raw);
    assert.equal(result.ok, false, `「${raw.slice(0, 20)}」必须不合格`);
    assert.equal(result.code, code, `「${raw.slice(0, 20)}」的原因应是 ${code}`);
    assert.ok(result.detail && result.detail.length > 4, '要说清为什么不合格');
  }
});

test('③ **不修剪**：拉丁泄漏是"不合格"，不是"把英文删掉就收下"', () => {
  const withLatin = '{"answer":"先看你 roster_total 里那几只。","basis":[]}';
  const result = parseLocalOutput(withLatin);
  assert.equal(result.ok, false);
  // 反证：如果实现改成"删掉英文再收下"，这里会变成 ok:true 且 answer 里没有 roster_total
  assert.equal(result.value, undefined, '不合格时不许给出任何可用值（给了就等于偷偷修好了）');
  // 契约自己也不含任何"清理"步骤：源码里不许出现针对模型输出的替换/删除
  const src = readFileSync(new URL('../src/coach/local-model.js', import.meta.url), 'utf8');
  const parserBody = src.slice(src.indexOf('export function parseLocalOutput'), src.indexOf('/**\n * 把证据包编成'));
  assert.doesNotMatch(parserBody, /answer\.replace\(|replace\(\/\[A-Za-z/,
    '解析器里不许对 answer 做替换（那就是"正则删除"那条老路）');
});

test('④ 契约必须出现在**发给模型的提示词**里（不是只写在注释里）', () => {
  for (const key of ['只输出一个 JSON 对象', 'answer', 'basis', '不许出现英文字母']) {
    assert.ok(LOCAL_SYSTEM_PROMPT.includes(key), `提示词里要写清「${key}」：${LOCAL_SYSTEM_PROMPT.slice(0, 80)}`);
  }
  assert.ok(LOCAL_OUTPUT_CONTRACT.version.includes('v1'), '契约有版本号（改了要能对上）');
});

test('⑤ on 档：不合格 ⇒ 如实降级，并且**分开记账**（没答 vs 答了不合格）', async () => {
  const bad = modelReturning('{"answer":"先看 hp 吧。"}');
  const provider = wrapWithLocalModel(localProvider, {model: bad, mode: 'on'});
  const answer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(),
    memory: freshMemory(), provider});
  assert.equal(bad.calls, 1, '要先真的问过模型');
  assert.equal(answer.provider, 'local-fallback', `不许把不合格的回答当模型答的：${answer.provider}`);
  assert.match(String(answer.fallbackReason), /latin-leak/, `原因要带具体 code：${answer.fallbackReason}`);
  assert.notEqual(String(answer.text), '先看 hp 吧。', '正文不许是被修剪过的模型输出');
  assert.deepEqual(provider.stats, {localUsed: 0, localFailed: 1, contractViolations: 1},
    `违规与失败要分开记账：${JSON.stringify(provider.stats)}`);

  const good = modelReturning(OK);
  const ok = wrapWithLocalModel(localProvider, {model: good, mode: 'on'});
  const okAnswer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(),
    memory: freshMemory(), provider: ok});
  assert.equal(okAnswer.provider, 'mlx-local');
  assert.equal(String(okAnswer.text), '先看速度线，快的先手。', '合规时正文就是 answer 那一段');
  assert.deepEqual(ok.stats, {localUsed: 1, localFailed: 0, contractViolations: 0});
});

test('⑥ shadow 档：违规只记账，玩家看到的仍是 base 的结果（不许被本地影响）', async () => {
  const base = {name: 'deepseek', async generate() { return 'base 的回答'; }};
  const bad = modelReturning('oops');
  const provider = wrapWithLocalModel(base, {model: bad, mode: 'shadow'});
  assert.equal(provider.name, 'deepseek', 'shadow 档名字照旧');
  const answer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(),
    memory: freshMemory(), provider});
  assert.equal(String(answer.text), 'base 的回答', '玩家看到的仍是 base');
  assert.deepEqual(provider.stats, {localUsed: 0, localFailed: 0, contractViolations: 1},
    `违规要记在 shadow 上：${JSON.stringify(provider.stats)}`);
  assert.equal(provider.shadow?.error_code, 'not-json', '影子记录里要写清哪种不合格');
});

test('⑦ 默认 off 档一个字都不变：模型 0 次调用、契约不参与', async () => {
  const model = modelReturning(OK);
  const provider = wrapWithLocalModel(localProvider, {model, mode: 'off'});
  assert.equal(provider, localProvider, 'off 档必须原样返回 base（逐字同一个对象）');
  await runCoach({message: '首发该上谁？', role: 'auto', context: camp(), memory: freshMemory(), provider});
  assert.equal(model.calls, 0, 'off 档一次都不许调模型');
});
