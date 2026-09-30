// task-27 / task-26 遗留第 4 条 · 玩家实测纠偏的判据（2026-09-30）
//
// 实测凭据（`tmp/accept-0930/` 只读参考）：问「上一局怎么样」时正文被**逐回合血量/事件长日志**淹没，
// 没有可执行的复盘；问什么都在陪练通道拿同一句「我在。聊游戏里的都行。」。
//
// 四条判据（Lead 指定）：
//   ① 正文**不得**出现逐行事件流（它在「依据」里，不在正文）
//   ② 四段结构存在：关键回合 → 当时合法替代 → 下一局试哪一手 → 风险
//   ③ 无分支证据时**不得**出现「必胜」类断言，且要点名缺哪一项
//   ④ 寒暄仍走 `companion`，且陪练兜底句**按意图**给（不是一句通吃）
//
// 跑法：node --test tests/roco-review-body-fallback.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// 玩家实测那一局的形状：第 9 回合防御（守后仍 143 血）、第 10 回合被龙之利爪击倒。
// **只有 turnLog（逐回合摘要），没有 keyTurns[].decision** —— 正是"无分支证据"的那种局。
const PLAYER_SEEN_MATCH = {
  id: 'accept-0930', result: 'loss', stage: '训练场', rounds: 12,
  turnLog: [
    {turn: 9, you: {name: '水蓝蓝', hp: 143, hpAfter: 143}, foe: {name: '烈火战神', hp: 210, hpAfter: 180},
      action: {kind: 'guard'}, events: ['水蓝蓝使用防御，减伤 70%。']},
    {turn: 10, you: {name: '水蓝蓝', hp: 143, hpAfter: 0}, foe: {name: '烈火战神', hp: 180, hpAfter: 160},
      action: {kind: 'skill', id: 'claw'}, events: ['龙之利爪 命中 水蓝蓝', '水蓝蓝倒下']},
  ],
};

const DUMP_LINE = /第\d+回合：你这边 .+；对面 .+；你/;

test('① 正文不得出现逐行事件流：流水只在「依据」（evidence）里', async () => {
  const {reviewMatch} = await import('../src/coach/teacher.js');
  const packet = reviewMatch({lastMatch: PLAYER_SEEN_MATCH});
  assert.doesNotMatch(String(packet.text), DUMP_LINE, `正文里出现了逐行事件流：${packet.text}`);
  assert(!/（龙之利爪 命中 水蓝蓝；水蓝蓝倒下）/.test(String(packet.text)), '正文不许贴事件数组原文');
  // 事实一条都没丢：它们整段在依据里
  assert(packet.evidence.some((e) => DUMP_LINE.test(e)), '逐回合原文必须还在依据里（只是不进正文）');
  assert(packet.evidence.some((e) => e.includes('143 血→0 血')), '血量变化要保留在依据里');
});

test('② 默认正文只给四段（关键回合 / 当时合法替代 / 下一局试哪一手 / 风险）', async () => {
  const {reviewMatch} = await import('../src/coach/teacher.js');
  const packet = reviewMatch({lastMatch: PLAYER_SEEN_MATCH});
  const text = String(packet.text);
  const labels = ['关键回合：', '当时合法替代：', '下一局试哪一手：', '风险：'];
  for (const label of labels) assert(text.includes(label), `四段缺「${label}」：${text}`);
  // 顺序也要对（玩家先读关键回合，再读替代与下一手，最后读风险）
  const at = labels.map((l) => text.indexOf(l));
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, `四段顺序不对：${JSON.stringify(at)}`);
  // 关键回合点的是**那一手真的决定生死的回合**（第 10 回合被击倒），而不是整段流水
  assert.match(text, /第10回合/, '关键回合要点名第 10 回合');
  assert.equal(text.match(/第\d+回合/g).length <= 3, true, `正文点名的回合数要少而准：${text}`);
});

test('③ 无分支证据：不许出现「必胜」类断言，且必须点名缺哪一项', async () => {
  const {reviewMatch} = await import('../src/coach/teacher.js');
  const packet = reviewMatch({lastMatch: PLAYER_SEEN_MATCH});
  const text = String(packet.text);
  assert.doesNotMatch(text, /必胜|稳赢|一定赢|肯定赢|必赢/, `无分支证据时出现了胜负断言：${text}`);
  assert.match(text, /缺当时的分支记录/, '要如实点名"缺当时的分支记录"');
  assert.match(text, /缺速度档位/, '要如实点名"缺速度档位"');
  assert.match(text, /不代表换一手就更好|不会说/, '要明确交代"不从事后结果反推"');
  // 有分支证据时不许再说"缺分支记录"（反证：缺口声明只在真缺的时候出现）
  const withDecision = reviewMatch({lastMatch: {...PLAYER_SEEN_MATCH, keyTurns: [{
    turn: 10, events: [], analysis: '当时可比较',
    alternatives: {gap: 9, rows: [{name: '换上烈火战神'}], line: '候选：换上烈火战神'},
    decision: {turn: 10, gap: 9, lesson: '换人承伤',
      chosen: {name: '继续输出', action: {kind: 'skill'}}, optionsComplete: true,
      situation: {playerPet: '水蓝蓝', playerHp: 143, playerEnergy: 3, enemyPet: '烈火战神', enemyHp: 180},
      options: [
        {name: '继续输出', action: {kind: 'skill'}},
        {name: '换上烈火战神', action: {kind: 'switch', name: '烈火战神'}},
      ],
      numbers: {}, consequence: {playerHp: 0, enemyHp: 160, playerFallen: ['水蓝蓝'], enemyFallen: []}},
  }]}});
  assert.doesNotMatch(String(withDecision.text), /缺当时的分支记录/,
    `有 decision 时不许再说"缺分支记录"（谎报缺口与谎报已结算一样糟）：${withDecision.text}`);
});

test('④ 寒暄仍走 companion（不许整条禁掉），且兜底句按意图给', async () => {
  const {runCoach} = await import('../src/coach/runtime.js');
  const {freshMemory} = await import('../src/coach/memory.js');
  const context = {mode: 'camp', profile: {pets: [{id: 'own-0001', pet_id: 'pet_000001', name: '喵喵'}]}};
  const hello = await runCoach({message: '今天天气不错', role: 'auto', context, memory: freshMemory(), conversation: []});
  assert.equal(hello.route, 'companion', '寒暄仍走陪练（task-26 的反证）');
  assert.match(String(hello.text), /我在|聊游戏里的都行/, '寒暄仍有兜底句');
  // 兜底句按**诉求**给：玩家实测那一问（「你觉得我有啥可以改进的」，intent 其实是 `other`）
  // 必须拿到可执行的下一步，而不是那句通用闲聊；寒暄保留通用句 —— 两者不同才算"不是一句通吃"。
  const {companion} = await import('../src/coach/companion.js');
  const ask = companion({}, {}, '你觉得我有啥可以改进的');
  const chat = companion({}, {}, '今天天气不错');
  assert.notEqual(String(ask.text), String(chat.text), '兜底句不许"一句通吃"');
  assert.match(String(ask.text), /说清想改哪块|配招|先手/, `改进这一问要给出可执行下一步：${ask.text}`);
  assert.doesNotMatch(String(ask.text), /聊游戏里的都行/, '改进这一问不许再拿通用闲聊');
  assert.match(String(chat.text), /我在|聊游戏里的都行/, `寒暄保留通用承接句：${chat.text}`);
  assert(String(ask.text).length <= 40, `兜底句仍要短（档位契约）：${ask.text}`);
});
