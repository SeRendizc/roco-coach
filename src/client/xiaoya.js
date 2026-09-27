// 小芽的**一份**实现：单独的小芽页面 + 其它页面右上角的弹出式入口。
//
// 为什么要有这个模块（人类 2026-09-25 纠偏①）：
//   · 「小芽就直接出一个单独的小芽页面，这个可以大点」——`xiaoya.html`；
//   · 「其他所有页面都要有右上角小芽和弹出式小芽」——培养页（nurture）与精灵盒子
//     （box）原来**完全没有**小芽，由这里的 `mountXiaoya({mode:'popup'})` 注入。
//
// 一条硬口径：**不另起一套对话能力**。这里的每一次提问都走营地页/训练场页同一条链：
//   `/api/coach`（`src/coach/client.js` 的 requestCoach）
//   + 同一份跨局记忆（localStorage `xiaoya-memory-v1`）
//   + 同一段对话记录（localStorage `xiaoya-chats-v1`，与营地页共用）。
// 所以「在小芽页面里聊过的」在营地页的小芽里接着看得到，反之亦然。
// 另写一份 payload 拼装是这类模块最常见的漂移来源（两份模板迟早不一致），
// 上下文一律用 `src/coach/runtime.js` 的 `buildContext()` 这一份构造器。
import {requestCoach, connectionStatus, readChatStore, serializeChatStore,
  activeChatSession, chatConversation, appendChatTurn, startChatSession, emptyChatStore} from '../coach/client.js';
import {buildContext} from '../coach/runtime.js';
import {freshMemory, readMemory} from '../coach/memory.js';
import {newProfile, loadProfile, PROFILE_STORAGE_KEY} from '../game/progression.js';
import {mountStalePageBanner} from './stale-page.js';
// 回答里的 `**加粗**` 要走 markdown 渲染：这个页面原来用 `createTextNode`（纯文本），
// 于是玩家看到的是**字面星号**（人类 2026-09-26：「说的是人话吗」那一批里的一个）。
// `markdown()` 先转义 HTML 再做少量替换，所以可以安全地插进 DOM。
import {markdown} from '../coach/experience.js';
import {playerEvidence} from './evidence-view.js';

//: 与 `src/client/app.js` **逐字相同**的两个键（改一个必须同时改另一个，否则小芽会分裂成两个）。
const MEMORY_KEY = 'xiaoya-memory-v1';
const CHAT_KEY = 'xiaoya-chats-v1';
// 键与营地/培养页**同一处来源**（`progression.js` 的 PROFILE_STORAGE_KEY），不在这里另写一份。
const PROFILE_KEY = PROFILE_STORAGE_KEY;
//: 三个开场问题：都能在**没有对局**的情况下回答（营地问答里最常被点的三个）。
// 2026-09-25（人类原话：「这个小芽不是 UI 的问题，是**内容**啊内容！你自己测试一下啊，
// 还有老版的宠物名字」）：这一页原来把教练上下文建成**本仓 MVP 练习局**那份存档
// （`pet-coach-growth-v1`：烬尾狐/潮甲龟/林鹿三只自研宠），于是满口老版宠物名 ——
// 而产品是《洛克王国：世界》的 622 图鉴。现在上下文改从手游那一侧来
// （`/api/roco/box?kind=mine`：48 只持有、真名/真属性/真等级），快捷问题也换成人手一只的手游问法。
const QUICK = ['我一共有多少只精灵？', '雨天水系伤害加多少？', '火系克制什么属性？', '你能做什么'];

const readStored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]));
//: 没有对局时交给教练的关卡 id。用营地页的初始值（`app.js` 的 `stageId='meadow'`），
//: 不许自造：本地教练会拿它去查真实关卡表，查不到就抛「关卡不存在」。
const CAMPAIGN_STAGE_ID = 'meadow';

/**
 * 小芽的一段会话状态（页面与弹窗各持有一份，但读写的是同一份存档）。
 *
 * 为什么把 `profile` 也读进来：`buildContext()` 要一份玩家档案（它会把档案里的
 * 伙伴与培养进度交给教练）。营地页有自己的那份；这里读的是**同一个存档键**，
 * 所以「我的精灵/培养到哪了」两个页面说的是同一件事。
 */
/**
 * 手游那一侧的玩家档案：**持有的精灵**（`/api/roco/box?kind=mine`）。
 *
 * 为什么不用本仓 MVP 存档（`pet-coach-growth-v1`）：那一份是**练习局夹具**
 * （烬尾狐/潮甲龟/林鹿三只自研宠），与 622 图鉴不是一套数据 —— 2026-09-25 人类实测
 * 这一页「还有老版的宠物名字」，根因就在这里。
 *
 * 形状与训练场页 `coachCampContext()` 一致（`{id,name,types,level,role,mechanism}` +
 * `pool_summary`），所以名单/阵容/属性问题在两个页面走同一套判据。
 * 拿不到（服务没起来 / 接口报错）⇒ 返回 `{pets: [], pool_summary: {}, unavailable: true}`：
 * 教练据此如实说"看不到你的名单"，**绝不**退回 MVP 那三只（那正是被点名的老版内容）。
 */
async function loadMobileProfile(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  try {
    const response = await fetchImpl('/api/roco/box?kind=mine&limit=48', {cache: 'no-store'});
    if (!response?.ok) throw new Error('box ' + response?.status);
    const body = await response.json();
    const player = body?.player;
    const cards = Array.isArray(player?.cards) ? player.cards : [];
    const pets = cards.map((card) => ({
      // `id` 用个体 id（own-XXXX，引擎的阵容评估要它）；
      // `species_id` 是**物种** id（pet_XXXXXX）—— 「我这几只里谁抗龙系」那类交集只能按物种比。
      id: card.select ?? card.group ?? null,
      species_id: typeof card.group === 'string' && /^pet_\d{6}$/.test(card.group) ? card.group : null,
      name: card.name ?? null,
      types: Array.isArray(card.types) ? card.types : [],
      level: Number.isFinite(card.level) ? card.level : null,
      role: card.role_label ?? null,
      mechanism: card.mechanism?.line ?? null,
    })).filter((pet) => pet.id && pet.name);
    if (!pets.length) throw new Error('empty box');
    return {
      pets,
      pool_summary: {
        ...(Number.isFinite(player.total) ? {total: player.total} : {}),
        source: 'owned',
        note: '名单来自精灵盒子（我的）；持有总数见 total。',
      },
    };
  } catch {
    return {pets: [], pool_summary: {}, unavailable: true};
  }
}

function createSession() {
  const profile = (() => { try { return loadProfile(readStored(PROFILE_KEY)); } catch { return newProfile(); } })();
  let chatStore = emptyChatStore();
  const raw = readStored(CHAT_KEY);
  if (raw) { try { chatStore = readChatStore(raw); } catch { chatStore = emptyChatStore(); } }
  if (!activeChatSession(chatStore)) chatStore = startChatSession(chatStore);
  const session = activeChatSession(chatStore);
  return {
    memory: readMemory(readStored(MEMORY_KEY)),
    profile,
    // 手游档案（异步一次）：页面与盒子/培养页那一档都用它；`null` = 还没取。
    mobileProfile: null,
    mobileProfileLoaded: false,
    // 交给教练的「当前伙伴」：档案里的第一只（`buildContext` 的 focus 只是接口上下文，
    // 没有对局时它不参与结算，但不能是编出来的 id）。
    pet: Object.keys(profile.pets ?? {})[0] ?? null,
    chatStore,
    conversation: session ? chatConversation(session) : [],
    role: 'auto',
    asking: false,
    epoch: 0,
  };
}

/** 把回答里可展开的那两层（依据 / 查了什么）画进一条对话里，与营地页同一套口径。 */
function decorate(entry, answer) {
  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  if (evidence.length) {
    const details = document.createElement('details');
    details.className = 'coach-evidence';
    const summary = document.createElement('summary');
    summary.textContent = '依据';
    details.append(summary);
    // 只给玩家看人话那一部分：`packet.evidence` 同时是"守卫核对数字用的账"，
    // 里面有 `RULES.guard={…}` 这类工程串（审计：训练场把整份摊给玩家看）。见 evidence-view.js。
    for (const line of playerEvidence(evidence)) {
      const p = document.createElement('p');
      p.textContent = line;
      details.append(p);
    }
    entry.append(details);
  }
  const trace = Array.isArray(answer.toolTrace) ? answer.toolTrace : [];
  if (trace.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '小芽查了什么';
    details.append(summary);
    // 13 个工具都要有中文名：漏一个，玩家就会在「小芽查了什么」里看到英文 id
    // （审计点名：原来只覆盖 8 个，evaluate_team 这类会原样上屏）。
    const names = {read_state: '当前局面', search_rules: '规则和战术', compare_actions: '行动分支',
      inspect_training: '培养面板', read_last_turn: '上一回合记录', read_match: '整局记录',
      read_evidence: '指定回合原始证据', simulate_branch: '假设行动分支',
      query_rules: '图鉴与规则表', evaluate_team: '阵容评估', search_knowledge: '战术卡',
      recall_memory: '跨局记忆', read_roster: '伙伴名单',
      compare_team_change: '换人对比', plan_actions: '行动规划', summarize_battle: '整局总结'};
    for (const receipt of trace) {
      const p = document.createElement('p');
      p.textContent = names[receipt.tool] ?? '引擎查询';   // 没登记的也不许把英文 id 端给玩家
      details.append(p);
    }
    entry.append(details);
  }
}

/** 连接状态那句话：与营地页同一条口径（模型没接上就明说只能给规则事实）。 */
function statusLine(answer) {
  if (answer.fallbackReason) return answer.fallbackReason;
  if (answer.provider === 'deepseek') return 'DeepSeek 已回答 · 依据可展开查看';
  return '本地规则核验 · 依据可展开查看';
}

/**
 * 挂载小芽。`mode:'page'` 用页面里已经写好的那几个 id（`xiaoya.html`）；
 * `mode:'popup'` 自己注入右上角的按钮 + 浮层（培养页 / 精灵盒子等）。
 *
 * 两种模式共用下面**同一段** ask / 渲染 / 存档逻辑 —— 「单独页面」与「弹出式」
 * 不是两个小芽，是同一个教练的两块版式。
 */
export function mountXiaoya({mode = 'popup', host = null} = {}) {
  if (document.body.dataset.xiaoyaMounted === 'yes') return null;
  document.body.dataset.xiaoyaMounted = 'yes';

  if (mode === 'popup') injectPopup(host);
  const el = (id) => document.getElementById(id);
  const log = el(mode === 'page' ? 'xy-log' : 'xiaoya-log');
  const form = el(mode === 'page' ? 'xy-form' : 'xiaoya-form');
  const input = el(mode === 'page' ? 'xy-input' : 'xiaoya-input');
  const send = el(mode === 'page' ? 'xy-send' : 'xiaoya-send');
  const status = el(mode === 'page' ? 'xy-status' : 'xiaoya-status');
  const quick = el(mode === 'page' ? 'xy-quick' : 'xiaoya-quick');
  const state = createSession();

  const setStatus = (text) => { if (status) status.textContent = text; };
  const addEntry = (who, text, answer = null) => {
    const entry = document.createElement('div');
    entry.className = `xy-entry${who === '你' ? ' user' : ''}`;
    const head = document.createElement('strong');
    head.textContent = who;
    entry.append(head);
    // 玩家自己说的话照旧纯文本（他说什么就显示什么）；小芽的回答走 markdown（只有加粗/行内码/换行）。
    if (who === '小芽') entry.insertAdjacentHTML('beforeend', markdown(text ?? ''));
    else entry.append(document.createTextNode(text ?? ''));
    if (answer) decorate(entry, answer);
    log?.append(entry);
    if (log) log.scrollTop = log.scrollHeight;
    return entry;
  };
  const persist = (question, answer) => {
    state.conversation = state.conversation.concat([
      {role: 'user', content: question}, {role: 'assistant', content: answer ?? ''}]).slice(-8);
    state.chatStore = appendChatTurn(state.chatStore, 'user', question);
    if (answer) state.chatStore = appendChatTurn(state.chatStore, 'assistant', answer);
    writeStored(CHAT_KEY, serializeChatStore(state.chatStore));
  };

  async function ask(text) {
    const message = String(text ?? '').trim();
    if (!message || state.asking) return;
    state.asking = true;
    if (send) send.disabled = true;
    if (input) input.disabled = true;
    addEntry('你', message);
    setStatus('正在读取依据…');
    const epoch = (state.epoch += 1);
    try {
      // 上下文由**唯一**那个构造器给出；`coachAllowed` 与营地页一致（这一页没有对局，
      // buildContext(null, …) 正是营地页问「怎么培养」时走的那条路）。
      // ⚠ stageId 必须是**真实存在的关卡 id**（营地页的初始值就是 'meadow'）：
      //   本地教练的「怎么培养」那一支会拿它去查关卡（content.js 的 stageOptions），
      //   给一个自造的值（曾经写成 'camp'）会抛「关卡不存在」——真无头 Chrome 实测过，
      //   表现是页面上「这次没有完成分析，请重试。」，而小测验那类问题却照常能答。
      // 手游那一档：持有名单先拿到手（一次请求、之后缓存）。拿不到就**不带 MVP 存档**，
      // 由教练如实说"看不到你的名单" —— 绝不退回那三只老版宠物。
      if (!state.mobileProfileLoaded) {
        state.mobileProfile = await loadMobileProfile();
        state.mobileProfileLoaded = true;
      }
      const activeProfile = state.mobileProfile ?? state.profile;
      const focus = Array.isArray(activeProfile.pets) ? (activeProfile.pets[0]?.id ?? null) : state.pet;
      const context = buildContext(null, activeProfile, focus, null, CAMPAIGN_STAGE_ID, message);
      context.coachAllowed = true;
      const answer = await requestCoach({message, role: state.role, context, memory: state.memory,
        conversation: state.conversation.slice(-8), stateToken: epoch});
      if (epoch !== state.epoch) return;                        // 又开了一段对话：这条回答作废
      state.memory = answer.memory ?? state.memory;
      writeStored(MEMORY_KEY, JSON.stringify(state.memory));
      const entry = addEntry('小芽', answer.text || '（这次没有拿到回答）', answer);
      // 小测验的选项直接可点（与营地页一致）：点一下就等于追问那个选项。
      if (Array.isArray(answer.choices)) {
        const row = document.createElement('div');
        row.className = 'xy-quick';
        for (const choice of answer.choices) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = choice;
          b.onclick = () => { row.remove(); void ask(choice); };
          row.append(b);
        }
        entry.append(row);
      }
      persist(message, answer.text ?? '');
      setStatus(statusLine(answer));
    } catch (error) {
      persist(message, '');
      addEntry('小芽', '这次没有完成分析，请重试。');
      setStatus(error?.message ?? '请求失败');
    } finally {
      state.asking = false;
      if (send) send.disabled = false;
      if (input) input.disabled = false;
    }
  }

  // 开场白只说这一页能做什么（不编造战况）：没有对局时也能问。
  addEntry('小芽', mode === 'page'
    ? '我是小芽。这一页对着**手游图鉴**说话：你的伙伴、属性相性、技能与学习表、天气与规则说明都能查。'
      + '没有连接模型时我只给引擎里查得到的事实，不猜。'
    : '我是小芽。随便问：你的伙伴、属性相性、技能与规则。');
  if (quick) {
    quick.replaceChildren(...QUICK.map((label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => void ask(label);
      return b;
    }));
  }
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask(input?.value ?? '');
    if (input) input.value = '';
  });
  if (mode === 'page') {
    document.querySelectorAll('[data-xy-role]').forEach((button) => {
      button.addEventListener('click', () => {
        state.role = button.dataset.xyRole;
        document.querySelectorAll('[data-xy-role]').forEach((b) => b.classList.toggle('selected', b === button));
        setStatus(`身份：${button.textContent}`);
      });
    });
  }
  // 连接状态：读不到就照实说读不到（不谎报「已连接」）。
  connectionStatus().then((info) => {
    setStatus(info?.configured ? `模型已连接（${info.provider ?? 'deepseek'}）· 依据可展开查看`
      : '未连接模型：小芽只给规则事实（去 connect.html 配置）');
  }).catch(() => setStatus('读不到模型连接状态（只给规则事实）'));

  // 模块图完整才跑得到这里：撤掉「脚本没加载成功」的兜底横幅。
  document.getElementById('boot-fallback')?.remove();
  return {ask, state};
}

/** 右上角入口 + 弹出式浮层（培养页 / 精灵盒子这一档轻页面用）。 */
function injectPopup(host) {
  const target = host ?? document.querySelector('.header-actions') ?? document.body;
  const button = document.createElement('button');
  button.className = 'xy-fab';
  button.id = 'xiaoya-open';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'xiaoya-pop');
  button.innerHTML = '<span aria-hidden="true">✦</span> 小芽';
  target.append(button);

  const pop = document.createElement('div');
  pop.className = 'xy-pop';
  pop.id = 'xiaoya-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '和小芽说话');
  pop.hidden = true;
  pop.innerHTML = '<div class="xy-pop-head"><strong>✦ 小芽</strong>'
    + '<span class="muted" id="xiaoya-status" role="status">正在读取连接状态…</span>'
    + '<button class="xy-pop-close" id="xiaoya-close" type="button" aria-label="关闭小芽">×</button></div>'
    + '<div class="xy-log" id="xiaoya-log" aria-live="polite"></div>'
    + '<div class="xy-quick" id="xiaoya-quick"></div>'
    + '<form class="xy-form" id="xiaoya-form"><input id="xiaoya-input" maxlength="500" autocomplete="off" '
    + 'placeholder="问小芽：怎么培养 / 出一道小测验"><button class="primary" id="xiaoya-send" type="submit">发送</button></form>';
  document.body.append(pop);

  const setOpen = (open) => {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) document.getElementById('xiaoya-input')?.focus();
  };
  button.addEventListener('click', () => setOpen(pop.hidden));
  // 只在这两处关：再点一次右上角的「小芽」，或点浮层里的 ×。
  //
  // 刻意**不做**「点别处自动收起」：人类 2026-09-25 纠偏②对阵容评估说的就是这件事
  //（「既然不遮挡，那就不要设置点别的地方自动消失」）。小芽这一层与它同类：
  // 点页面别处常常是想一边看内容一边问，自动收起只会把刚打的字弄丢。
  pop.querySelector('#xiaoya-close')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !pop.hidden) setOpen(false); });
}

// 单独的小芽页面（`xiaoya.html`）：body 上的钩子就是它的挂载点。
if (typeof document !== 'undefined' && document.body?.dataset.xiaoyaPage === 'yes') mountXiaoya({mode: 'page'});

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();
