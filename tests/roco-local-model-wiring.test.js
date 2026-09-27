/**
 * 判据：4B（本地模型）**真的进链路**了吗？（人类 2026-09-26 直接问的那一句）
 *
 * 修前的实情（真机实测，见台账 §C6.245/§C6.252）：`ROCO_LOCAL_MODEL=on` 时
 * `server/index.js` 把底层换成 `localProvider`（name=`'local'`），而包装层 `wrapWithLocalModel`
 * 又把名字原样保留成 base 的名字 ⇒ `runtime.js` 的 `useModel = provider.name!=='local'` 恒假
 * ⇒ **4B 的 `generate` 一次都不执行**，玩家拿到的是引擎模板（8 问里 3 条只回三个字「我在。」）。
 *
 * 这一组判据钉三件事：① on 档包装层如实叫 `mlx-local`；② 真被调用、且回执如实；
 * ③ 本地失败时**不许**报成"模型答的"（要标 `local-fallback` 并写清原因）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapWithLocalModel} from '../src/coach/local-model.js';
import {runCoach, localProvider} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {cloudDecision} from '../src/coach/model-routing.js';
import {createLocalPlan, localPrompt, plainForModel, LOCAL_SYSTEM_PROMPT} from '../src/coach/local-model.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const camp = () => ({mode: 'camp', battle: null,
 profile: {pets: [{id: 'pet_000118', name: '皇家狮鹫', types: ['风系'], stats: {spe: 120}}]}});
/** 一个**可控的假模型**：只记调用次数、按剧本返回或抛错。 */
const fakeModel = (behaviour = 'ok') => ({
 calls: 0,
 async generate() {
  this.calls += 1;
  if (behaviour === 'timeout') throw Object.assign(new Error('本地推理超时'), {code: 'timeout'});
  // 改钉（2026-09-27）：包装层现在按**输出契约**校验 ⇒ 夹具必须返回契约要求的 JSON。
  // 这一条同时说明契约在起作用：纯文本「模型说的话」会被判 `not-json` 并降级（判据在
  // tests/roco-local-output-contract.test.js ②）。
  return {text: JSON.stringify({answer: '模型说的话', basis: []}), total_ms: 12};
 },
});

test('① on 档包装层如实叫 mlx-local；shadow 档保留 base 的名字（反证）', () => {
 const base = {name: 'deepseek', async generate() { return 'base'; }};
 const on = wrapWithLocalModel(base, {model: fakeModel(), mode: 'on'});
 assert.equal(on.name, 'mlx-local', 'on 档它真的是模型，名字必须如实 —— 名字错了 runtime 就以为"没接模型"');
 const shadow = wrapWithLocalModel(base, {model: fakeModel(), mode: 'shadow'});
 assert.equal(shadow.name, 'deepseek', 'shadow 档玩家看到的结果来自 base，名字必须照旧（否则日志与判据口径漂）');
 const off = wrapWithLocalModel(base, {model: fakeModel(), mode: 'off'});
 assert.equal(off, base, 'off 档必须原样返回 base（逐字同一个对象）');
});

test('② on 档 4B **真的被调用**（反证：等价修前的写法 ⇒ 一次都不调）', async () => {
 const model = fakeModel('ok');
 const provider = wrapWithLocalModel(localProvider, {model, mode: 'on'});
 const answer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(), memory: freshMemory(), provider});
 assert.equal(model.calls, 1, `4B 必须被调用一次（实际 ${model.calls} 次）`);
 assert.equal(answer.provider, 'mlx-local', `回执要如实说是本地模型答的：${answer.provider}`);
 assert.equal(String(answer.text), '模型说的话', '正文就是模型给的文本');

 // 反证：把包装层的名字换回 base 的名字（= 修前的行为），同一条链路必须**一次都不调**
 const brokenModel = fakeModel('ok');
 const broken = {...wrapWithLocalModel(localProvider, {model: brokenModel, mode: 'on'}), name: 'local'};
 const brokenAnswer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(),
  memory: freshMemory(), provider: broken});
 assert.equal(brokenModel.calls, 0, '名字是 local 时 runtime 不认它是模型 —— 这就是"4B 接不进来"的根因');
 assert.equal(brokenAnswer.provider, 'local', '修前那条路的回执写 local（引擎模板）');
});

test('③ 本地失败要如实标降级：provider=local-fallback + 说清原因，不许报成模型答的', async () => {
 const model = fakeModel('timeout');
 const provider = wrapWithLocalModel(localProvider, {model, mode: 'on'});
 const answer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(), memory: freshMemory(), provider});
 assert.equal(model.calls, 1, '失败也要先真的试过');
 assert.equal(answer.provider, 'local-fallback', `超时后不许说这是模型答的：${answer.provider}`);
 assert.match(String(answer.fallbackReason), /timeout/, `原因要带上错误码：${answer.fallbackReason}`);
 assert.notEqual(String(answer.text), '模型说的话', '降级时正文是引擎模板，不是模型文本');
});

test('④ 可用性真信号接进决策：本地不可用 + 有 key ⇒ 允许云端（三档链才成立）', () => {
 const allowed = cloudDecision({task: 'review', cloudConfigured: true, localAvailable: false,
  localRejected: false, remainingMs: 5000});
 assert.equal(allowed.useCloud, true, '本地不可用且有 key 时，值这个钱的任务要能走云端');
 assert.equal(allowed.conditions.local_not_usable, true);
 const keptLocal = cloudDecision({task: 'review', cloudConfigured: true, localAvailable: true,
  localRejected: false, remainingMs: 5000});
 assert.equal(keptLocal.useCloud, false, '本地可用时不该花这个钱');
});

test('⑤ on 档的规划器必须真的能跑（反证：把 planner 对象当函数 ⇒ agentStop=planner-failed）', async () => {
 // 2026-09-26 子代理核实挖出的真缺陷（文档里一个字都没有）：`src/server/index.js` 的 on 档
 // 曾经写 `wrapped.plan=localPlan`，而 `createLocalPlan()` 返回的是**对象**（函数在 `.plan` 上）
 // ⇒ runtime 里 `await provider.plan(...)` 抛 TypeError ⇒ **on 档云端与本地规划器都不跑**，
 // 每轮只剩政策强制的第一枪。当时**没有任何判据覆盖 on 档 planner**（这份文件绕过了
 // `applyLocalModel`，`server.test.js` 只测 off/shadow）——所以这一条补上。
 const server=readFileSync(fileURLToPath(new URL('../src/server/index.js', import.meta.url)), 'utf8');
 assert.match(server, /wrapped\.plan=\(task\)=>localPlan\.plan\(task\)/, 'on 档要把 planner 包成函数');
 assert.doesNotMatch(server, /wrapped\.plan=localPlan;/, '不许再把 planner 对象当函数赋值（那会让规划器整条不跑）');

 // 行为面：包好的函数真的是函数、且调得动
 const plan=createLocalPlan({model: fakeModel('ok'), tools: ['read_state']});
 const wrapped=wrapWithLocalModel(localProvider, {model: fakeModel('ok'), mode: 'on'});
 wrapped.plan=(task)=>plan.plan(task);
 assert.equal(typeof wrapped.plan, 'function', 'on 档的 plan 必须是函数');
 const decision=await wrapped.plan({message: '帮我看看这局', context: camp(), state_version: 1});
 assert.ok(decision && typeof decision==='object', `本地规划器要返回一个决策：${JSON.stringify(decision)?.slice(0,80)}`);

 // 反证：老写法（对象直接赋给 plan）必须是**不可调用**的 —— 这就是那个缺陷的形状
 const broken={...wrapWithLocalModel(localProvider, {model: fakeModel('ok'), mode: 'on'}), plan};
 assert.notEqual(typeof broken.plan, 'function', '老写法把对象放在 plan 上（不可调用）——判据要能识别这个形状');
});

test('⑥ 发给 4B 的问句里必须有**玩家原话**（反证：只给草稿 ⇒ 模型不知道在答什么）', () => {
 // 修前 `runLocal` 发出去的就是 `packet.text`（3–25 字草稿）。真机实测（/tmp/fourb/fourb.mjs）：
 // 冷启 5135 ms 后模型回「您似乎只输入了我在。」——它没坏，是没人告诉它要干什么。
 const full = localPrompt({message: '首发该上谁？', text: '按速度档，潮甲龟先手。', evidence: ['水系克制火系']});
 assert.match(full, /首发该上谁？/, '玩家原话必须在问句里');
 assert.match(full, /潮甲龟先手/, '引擎给的事实必须在问句里');
 assert.match(full, /水系克制火系/, '依据要带上，否则模型只能自己编');
 // 反证：不带 message 的包（= 修前的形状）编出来**没有玩家问题** —— 判据能识别这个差别
 const old = localPrompt({text: '按速度档，潮甲龟先手。'});
 assert.doesNotMatch(old, /玩家问：/, '没有玩家原话时不该凭空出现"玩家问"');
 assert.ok(!old.includes('首发该上谁？'), '修前那种包本来就没有玩家问题 —— 这正是根因');
 assert.ok(LOCAL_SYSTEM_PROMPT.includes('小芽'), '系统约定要给它身份与说话方式');
 assert.ok(LOCAL_SYSTEM_PROMPT.includes('不许自己算一个'), '数字纪律要在系统约定里说死');
 // 超长时**只裁依据**，玩家原话与引擎草稿必须留（裁掉就等于回到老路）
 const long = localPrompt({message: '首发该上谁？', text: '按速度档，潮甲龟先手。',
  evidence: Array.from({length: 40}, (_, i) => `依据条目${i}：`.padEnd(200, '字'))}, {maxChars: 1200});
 assert.ok(long.length <= 1200, `裁完还得在预算内（实际 ${long.length}）`);
 assert.match(long, /首发该上谁？/, '玩家原话永远不裁');
 assert.match(long, /潮甲龟先手/, '引擎草稿永远不裁');
});

test('⑦ 4B 那一枪真的带上了玩家原话（端到端穿透 packet → 模型）', async () => {
 let seen = null;
 // 改钉（2026-09-27）：按输出契约返回 JSON（纯文本会被判 not-json 并降级）。
 const model = {calls: 0, async generate(args) {
   this.calls += 1; seen = args;
   return {text: JSON.stringify({answer: '模型说的话', basis: []}), total_ms: 9};
 }};
 const provider = wrapWithLocalModel(localProvider, {model, mode: 'on'});
 // 注意问题要选**真的需要模型**的那种：「龙系克制哪些属性」是纯事实，引擎自己答，
 // 0 次模型调用是对的（第一次写这条判据时就是栽在这里，实测 0 !== 1）。
 const answer = await runCoach({message: '首发该上谁？', role: 'auto', context: camp(),
  memory: freshMemory(), provider});
 assert.equal(model.calls, 1, 'on 档 4B 要真被调用');
 assert.ok(seen && typeof seen.prompt === 'string', '本地这一路要收到 prompt 字符串');
 assert.match(seen.prompt, /首发该上谁？/,
  `发给 4B 的问句里必须有玩家原话，实际：${String(seen?.prompt).slice(0, 120)}`);
 assert.ok(String(seen.system || '').includes('小芽'), '系统约定要一起发过去（不给约定＝又变成"没人告诉它要干什么"）');
 assert.notEqual(seen.prompt.trim(), '这里放的是引擎草稿', 'prompt 不许是干草稿');
 assert.equal(String(answer.text), '模型说的话', '模型文本照旧是正文');
});

test('⑧ 交给 4B 的材料不许夹工程记号（真机实测：它会把 roster_total / hp 原样念给玩家）', () => {
 // 这条是**真机复测逼出来的**：先在系统约定里写"英文字段名要换成中文"，4B 反而照抄得更凶
 // （冷启 5.4s 回答「先确认你 roster_total 里的 48 只，再按 hp 和 spe 选最强的」）。
 // 4B 跟着材料走、不跟着约定走 ⇒ 只能由代码在发出之前洗干净。
 const raw = '名单说明：profile.pets 里是**候选池的一页**（本页 1 条候选宇宙共 622 条），玩家可用的名单共 48 只（roster_total）。';
 // 反证：原始材料里这些记号**确实在**（不然这条判据就是空的）
 assert.match(raw, /roster_total/); assert.match(raw, /profile\.pets/); assert.match(raw, /\*\*/);
 const clean = plainForModel(raw);
 assert.doesNotMatch(clean, /[a-z][a-z0-9]*_[a-z0-9_]+/, `不许剩下 snake_case：${clean}`);
 assert.doesNotMatch(clean, /\*\*/, `不许剩下星号：${clean}`);
 assert.doesNotMatch(clean, /\b(hp|spe|atk|def)\b/, `光杆字段名也要换：${clean}`);
 assert.match(clean, /名单总数/, `要换成中文说法，而不是删掉这个事实：${clean}`);
 assert.match(clean, /48 只/, '数字必须原样保留（那是事实，不许洗掉）');
 const prompt = localPrompt({message: '首发该上谁？', text: '按 hp 和 spe 排。', evidence: [raw]});
 assert.doesNotMatch(prompt, /roster_total|profile\.pets|\*\*/, `发给模型的整句也不许带记号：${prompt}`);
 assert.match(prompt, /首发该上谁？/, '玩家原话照旧不动（那是他自己打的字）');
 assert.match(prompt, /速度/, '`spe` 要按中文说（速度）');
});
