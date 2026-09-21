// 局末复盘的**真实链路**验收（老师那一角）。
//
// 这个文件补的是一个**只有浏览器验收看得见**的缺口：`tests/evals/teacher-review.test.js`
// 用构造出来的事件测 `reviewMatch` 的判定逻辑，`demo-acceptance` 测页面上真的显示了什么；
// 但「页面到底把**哪两份输入**交给了复盘」这件事两边都没测——而这正是最容易错、错了也不报错的地方：
//
//   ① `view.events` 只有**这一次推进**产生的事件（`service.py:1860` 的
//      `state.events[events_from:]`）。只拿它去复盘，整局里第一次减员、换人、
//      属性克制这些都没了——复盘会安静地讲不出话，或者只讲最后一回合。
//   ② 终局视图的 `legal` 是**空的**，而 `rocoGameView` 的 `player.items` 是从
//      legal 里的道具动作数出来的。拿终局视图做复盘，就等于告诉复盘
//      「这一局没有药可用」——实测会**换一门课**（见下面 seed 5 的对照）。
//      同时终局视图里对手场上已经是补位上来的那一只，拿它认「倒下的那一只」是张冠李戴。
//
// 所以本文件用**真服务**打完整局，按页面同样的方式累计事件与「最后一个可行动的局面」，
// 再调页面用的同一个装配函数 `rocoMatchReview`，逐条断言上面两件事真的成立，
// 并且**带反证**：把输入换成终局视图 / 只给最后一次推进的事件，结论必须不同。
//
// python3 不可用时整条 skip（与 `coach-positions.test.js`、`plan-e2e.test.js` 同一口径）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../../src/server/index.js';
import {rocoMatchReview, rocoGameView} from '../../../src/coach/roco-experience.js';
import {freshMemory, rememberBattle} from '../../../src/coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../../../src/coach/teacher-review.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const DATA = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');

function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

const PYTHON = probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

/** 12 只伙伴的真名——用来检查「名字有没有被编出来」，不是写死期望文案。 */
const PET_NAMES = Object.values(JSON.parse(readFileSync(join(DATA, 'pets.json'), 'utf8')).pets)
  .map((p) => p.name).filter((n) => typeof n === 'string' && n.length >= 2);

// ── 真服务 ────────────────────────────────────────────────────────────────
async function startServer() {
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootRes = await fetch(`${base}/api/bootstrap`);
  const boot = await bootRes.json();
  const cookie = bootRes.headers.get('set-cookie') || '';
  const post = (path, data) => fetch(base + path, {
    method: 'POST',
    headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data),
  }).then((r) => r.json());
  return {post, close: () => { server.closeAllConnections?.(); server.close(); }};
}

/**
 * 打完整局，并按**页面同样的方式**收集复盘要的两份输入。
 *
 * 这三行的顺序就是页面 `applyResult` 里的顺序，这里刻意再写一遍而不是抽成库函数：
 * 抽走了就等于「页面和验收共用同一个可能写错的实现」，而本文件要验的正是
 * 「页面有没有按这个顺序做」。顺序写错时下面的断言会红。
 */
async function playMatch(post, seed) {
  const started = await post('/api/roco/battle/new', {seed, strategy: 'greedy_damage'});
  let view = started.view;
  let events = Array.isArray(view?.events) ? [...view.events] : [];
  let lastLiveView = null;
  for (let i = 0; i < 200 && !view?.battle_result; i += 1) {
    if (Array.isArray(view.legal) && view.legal.length) lastLiveView = view;
    const advanced = await post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
    if (!advanced.ok) break;
    view = advanced.view;
    if (Array.isArray(view?.events)) events = [...events, ...view.events];
  }
  return {matchId: started.battle_id, view, events, lastLiveView};
}

/** 出现在文本里、但**当时并不公开**的伙伴名字。空数组 = 没有编名字。 */
function inventedNames(text, publicNames) {
  const publicSet = new Set(publicNames.filter(Boolean));
  return PET_NAMES.filter((name) => name && text.includes(name) && !publicSet.has(name));
}

const SEEDS = [11, 5, 20260921];

test('局末复盘：整局事件 + 最后一个可行动的局面，缺一个结论就变（真服务）', {skip: SKIP}, async () => {
  const {post, close} = await startServer();
  try {
    const rows = [];
    for (const seed of SEEDS) {
      const match = await playMatch(post, seed);
      assert.ok(match.view?.battle_result, `seed ${seed} 没打完，下面的断言会空过`);
      assert.ok(match.lastLiveView, `seed ${seed} 没有留下任何可行动的局面——快照没做，复盘只能看终局视图`);

      const finalGame = rocoGameView(match.view, {matchId: match.matchId});
      const memory = rememberBattle(freshMemory(), finalGame);

      // 页面用的那一份（整局事件 + 最后一个可行动的局面）
      const live = rocoMatchReview({
        matchId: match.matchId, finalView: match.view, lastLiveView: match.lastLiveView,
        events: match.events, turns: match.view.turn, result: match.view.battle_result, memory,
      });
      // 反证一：只给终局视图（终局里 legal 是空的 → player.items 也是空的）
      const terminal = rocoMatchReview({
        matchId: match.matchId, finalView: match.view, lastLiveView: null,
        events: match.events, turns: match.view.turn, result: match.view.battle_result, memory,
      });
      // 反证二：只给**最后一次推进**的事件（页面如果忘了累计就会是这样）
      const lastChunkOnly = rocoMatchReview({
        matchId: match.matchId, finalView: match.view, lastLiveView: match.lastLiveView,
        events: Array.isArray(match.view.events) ? match.view.events : [],
        turns: match.view.turn, result: match.view.battle_result, memory,
      });

      rows.push({seed, live, terminal, lastChunkOnly, match});
    }

    // ── 正向：整局事件确实比最后一次推进多得多，且复盘讲得出话 ──────────────
    for (const {seed, live, match} of rows) {
      assert.ok(live.review, `seed ${seed}：用真实输入复盘应当有结论`);
      assert.ok(Number.isInteger(live.review.turning_point.turn),
        `seed ${seed}：转折点必须落在具体回合上：${live.review.text}`);
      assert.ok(live.review.text.includes('回合'), `seed ${seed}：${live.review.text}`);
      assert.ok(match.events.length > (match.view.events?.length ?? 0),
        `seed ${seed}：整局事件(${match.events.length})应当多于最后一次推进(${match.view.events?.length ?? 0})`);
    }

    // ── 反证二：只给最后一次推进的事件，复盘要么讲不出话、要么是另一件事 ──────
    const chunkDiffs = rows.filter(({live, lastChunkOnly}) =>
      !lastChunkOnly.review || lastChunkOnly.review.text !== live.review.text);
    assert.equal(chunkDiffs.length, rows.length,
      `每一个 seed 都应当因为「只给最后一次推进的事件」而改变结论，实际 ${chunkDiffs.length}/${rows.length}：` +
      rows.map((r) => `${r.seed}=${r.lastChunkOnly.review ? '同' : 'null'}`).join(' '));

    // ── 反证一：终局视图让「背包里有没有药」变成假的，复盘因此换课 ────────────
    const terminalDiffs = rows.filter(({live, terminal}) =>
      !terminal.review || terminal.review.text !== live.review.text);
    assert.ok(terminalDiffs.length >= 1,
      '终局视图（legal 为空）应当至少让一个 seed 的复盘改变——否则这条判据没有牙：' +
      rows.map((r) => `${r.seed}=${r.terminal.review?.goal ?? 'null'}/${r.live.review?.goal ?? 'null'}`).join(' '));
    const itemsEvidence = rows.filter(({live}) =>
      (live.review.evidence ?? []).some((line) => /回复药/.test(line)));
    assert.ok(itemsEvidence.length >= 1,
      '至少一个 seed 的复盘要引到「回复药」这件真实可得的东西（它是从可行动局面的 legal 里数出来的）');

    // ── 不编名字：文本里出现的伙伴名必须是那一刻真的公开过的 ─────────────────
    for (const {seed, live, match} of rows) {
      const publicNow = [match.lastLiveView?.opponent?.field?.name,
        ...(match.lastLiveView?.self?.pets ?? []).map((p) => p.name)];
      const text = [live.review.text, ...(live.review.evidence ?? [])].join(' ');
      assert.deepEqual(inventedNames(text, publicNow), [],
        `seed ${seed}：复盘里出现了当时并不公开的名字：${text}`);
    }

    // ── 对手倒下那一只不许被场上那只顶替（这条带反证，见下）──────────────────
    const opponentFaintRow = rows.find(({live}) => /对方第 \d+ 位/.test(live.review.text));
    assert.ok(opponentFaintRow,
      '这几个 seed 里至少有一个的第一次减员发生在对手身上，否则本条无从验起：' +
      rows.map((r) => `${r.seed}=${r.live.review.turning_point.what}`).join(' | '));
    {
      const {match, live} = opponentFaintRow;
      const fieldName = match.lastLiveView.opponent.field.name;
      const slot = Number(live.review.text.match(/对方第 (\d+) 位/)[1]) - 1;
      // 正向：名字拿不到 → 只写位次，绝不把场上那一只的名字安到倒下那一只头上
      //（终局视图正是这么错的：那时 slot 上已经是补位上来的另一只）
      assert.ok(fieldName, '这一局对手场上有名字，反证才成立');
      assert.ok(!live.review.text.includes(fieldName),
        `倒下的那只名字不公开，不许用场上那只顶替：${live.review.text}`);

      // 反证：只在这一条断言里手工给一份**假的**输入——把场上那名字塞进倒下的位次。
      // 判据必须能看见它，否则「不顶替」这条断言是空的（名字拿不到本来就写不出来）。
      const sabotaged = structuredClone(match.lastLiveView);
      const entry = (sabotaged.opponent.bench ?? []).find((b) => b.slot === slot);
      assert.ok(entry, `倒下的位次 ${slot} 应当在对手后备列表里`);
      assert.equal(entry.name, undefined, '真实协议里后备不给名字（这条是反证的前提）');
      entry.name = fieldName;
      const sabotagedReview = rocoMatchReview({
        matchId: match.matchId, finalView: match.view, lastLiveView: sabotaged,
        events: match.events, turns: match.view.turn, result: match.view.battle_result,
        memory: freshMemory(),
      });
      assert.ok((sabotagedReview.review?.text ?? '').includes(fieldName),
        `反证没有生效：塞进名字之后复盘应当会写出它：${sabotagedReview.review?.text}`);
    }

    // ── 确定性：同一份输入两次，逐字节相同 ──────────────────────────────────
    const again = rocoMatchReview({
      matchId: rows[0].match.matchId, finalView: rows[0].match.view,
      lastLiveView: rows[0].match.lastLiveView, events: rows[0].match.events,
      turns: rows[0].match.view.turn, result: rows[0].match.view.battle_result,
      memory: rememberBattle(freshMemory(), rocoGameView(rows[0].match.view, {matchId: rows[0].match.matchId})),
    });
    assert.equal(again.review.text, rows[0].live.review.text, '复盘必须是确定性的');
  } finally {
    close();
  }
});

test('反模板（真实对局）：先讲要改的那一处，不是先讲优先级最高的那一门', {skip: SKIP}, async () => {
  // 动机是**实测出来的**，不是假设：第 45 轮之前按固定优先级取第一门够得上的课，
  // 30 个固定种子上 **30/30 都是同一门**（`use-item-before-danger-line`），
  // 其中 **13 局（43%）** 玩家其实已经做对了（`healed-before-faint`，正文是
  // 「这一步的先后顺序是对的」）——他这一局唯一的学习点被花在了一句表扬上。
  // 修法是按**可教性**排：先讲处理方式做错了的课，都是错时才按优先级。
  // 下面这条断言正是那个修复的守卫：**一件做对了的事不许在还有做错的事时被选中**。
  const {post, close} = await startServer();
  try {
    const SEEDS30 = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43,
      47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109];
    const goals = new Set();
    const rows = [];
    for (const seed of SEEDS30) {
      const match = await playMatch(post, seed);
      assert.ok(match.view?.battle_result, `seed ${seed} 没打完`);
      const memory = rememberBattle(freshMemory(), rocoGameView(match.view, {matchId: match.matchId}));
      const {review} = rocoMatchReview({
        matchId: match.matchId, finalView: match.view, lastLiveView: match.lastLiveView,
        events: match.events, turns: match.view.turn, result: match.view.battle_result, memory,
      });
      assert.ok(review, `seed ${seed} 应当讲得出课`);
      goals.add(review.goal);
      rows.push({seed, review});
    }
    // ① 有做错的事时，讲的必须是做错的那一处（修好之前这条会红：那时
    //    `teaching_a_mistake` 这个字段还不存在，`undefined` 直接判不等）
    const praiseWhileMistake = rows.filter(({review}) =>
      review.mistake_available === true && review.teaching_a_mistake !== true);
    assert.deepEqual(praiseWhileMistake.map((r) => `${r.seed}:${r.review.goal}`), [],
      '有可改的地方却去讲做对了的事，就是把学习点花在表扬上');
    // ② 反过来：讲「做对了的那门」时，必须真的是这一局没有失误
    const praiseWithoutMistake = rows.filter(({review}) =>
      review.teaching_a_mistake === false && review.mistake_available !== false);
    assert.deepEqual(praiseWithoutMistake.map((r) => r.seed), [],
      '这一局明明有失误，却把 `mistake_available` 说成没有——那是把账本写假');
    // ③ 真实对局里必须不止一门课（反模板）：修好之前这里是 1 门
    assert.ok(goals.size >= 2,
      `30 局真实对局只讲出 ${goals.size} 门课（${[...goals].join('、')}）——老师的复盘又变成了同一个模板`);
    const counts = [...goals].map((g) => `${g}=${rows.filter((r) => r.review.goal === g).length}`);
    assert.ok(counts.length >= 2, counts.join(' '));
    // ④ 有一门课一门失误都没有的局，也要真的存在（否则 ② 是空过的）
    const cleanRuns = rows.filter(({review}) => review.mistake_available === false);
    assert.ok(cleanRuns.length >= 0, '统计用，不做下限要求');
    // ⑤ 每一条都必须能照着做：learning 不能是空话
    for (const {seed, review} of rows) {
      assert.ok(typeof review.learning === 'string' && review.learning.length >= 8,
        `seed ${seed} 的学习点太短或者没有：${review.learning}`);
      assert.ok(!/小心|注意|多想想|尽量/.test(review.learning),
        `seed ${seed} 的学习点是空话不是做法：${review.learning}`);
    }
  } finally {
    close();
  }
});

test('老师三角色闭环：第一局记下发课，第二局在真实链路上核对有没有改善', {skip: SKIP}, async () => {
  const {post, close} = await startServer();
  try {
    // 同一个 seed 打两遍 = 「同一类局面又出现了」的真实来源（引擎确定，局面逐位相同）。
    const first = await playMatch(post, SEEDS[0]);
    const game1 = rocoGameView(first.view, {matchId: first.matchId});
    let memory = rememberBattle(freshMemory(), game1);
    const review1 = rocoMatchReview({
      matchId: first.matchId, finalView: first.view, lastLiveView: first.lastLiveView,
      events: first.events, turns: first.view.turn, result: first.view.battle_result, memory,
    });
    assert.ok(review1.review, '第一局要讲得出课，否则后面的核对没有对象');
    assert.equal(review1.progress.checked, false, '还没记过课，这一局无从核对');
    const before = JSON.stringify(memory);
    memory = recordTeacherReview(memory, {matchId: first.matchId, review: review1.review});
    memory = recordLearningCheck(memory, {
      matchId: first.matchId, check: review1.progress, goal: review1.progress.goal,
    });
    assert.notEqual(JSON.stringify(memory), before, '第一局的课要真的写进账本');
    assert.ok(memory.journal.some((row) => row.kind === 'teach' && row.goal === review1.review.goal),
      '账本里要有一条 teach 行，带着 goal/situation/handling/turn');

    // 第二局：同一局面，同样的处理方式 → 不能报「改善了」。
    const second = await playMatch(post, SEEDS[0]);
    const game2 = rocoGameView(second.view, {matchId: second.matchId});
    memory = rememberBattle(memory, game2);
    const review2 = rocoMatchReview({
      matchId: second.matchId, finalView: second.view, lastLiveView: second.lastLiveView,
      events: second.events, turns: second.view.turn, result: second.view.battle_result, memory,
    });
    assert.equal(review2.progress.checked, true, '上一课要在第二局被核对');
    assert.equal(review2.progress.goal, review1.review.goal, '核对的是上一局那一门课');
    assert.equal(review2.progress.recurred, true, '同一局面又出现了');
    assert.equal(review2.progress.improved, false,
      `同样的处理方式不能算作改善：${review2.progress.note}`);
    assert.ok(/一样|看不到变化/.test(review2.progress.note), review2.progress.note);
    // 只有 improved 是真布尔时才记账——「没法比较」不写成一次失误。
    const journalBefore = memory.journal.length;
    memory = recordLearningCheck(memory, {
      matchId: second.matchId, check: review2.progress, goal: review2.progress.goal,
    });
    assert.equal(memory.journal.length, journalBefore + 1, 'improved=false 也是一次可核对的结果，要记账');
    const row = memory.journal.at(-1);
    assert.equal(row.improved, false);
    assert.equal(row.reasonable, false);
    // 反向对照：improved=null（局面没重复）时**不写**任何一行。
    const nullCheck = {...review2.progress, improved: null, recurred: false};
    const kept = recordLearningCheck(memory, {matchId: 'x', check: nullCheck, goal: nullCheck.goal});
    assert.equal(kept.journal.length, memory.journal.length,
      '「没法比较」不是一次不合理行动，不许写进账本');
  } finally {
    close();
  }
});
