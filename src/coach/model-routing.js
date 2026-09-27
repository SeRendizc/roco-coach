// RC-901「三档路由与降级链」的**第一条可执行切片**：云端只在「值这个钱」时才发。
//
// 规划出处：`docs/roadmap/MODEL-ROUTING-PLAN.md` §2.3 建议新增第 3 条 ——
//   「**云端只在『值这个钱』时才发**：判定条件写死为**可判定的三条** ——
//     ① 任务类型 ∈ {长复盘, 开放性提问, 局末教学}；② 4B 档不可用或置信不足；③ 预算还够（< 2500ms 余量）。
//     **反证**：把它降级成「一律先问云端」必须红（那会把 4B 的意义抹掉，也把延迟顶到秒级）。"
//
// 为什么单独一个纯模块：三条条件必须**可判、可测、可回执**，而 `src/server/index.js` 里
// 那条 provider 选择链是 `credential?cloud:local` 的两档二分（`:448` 起）——
// 在服务里现算这三条，判据就只能起真服务去撞；抽成纯函数之后 `test:unit` 直接量。
//
// ⚠ 这一模块**不做任何 I/O、不读环境变量、不调模型**（与 `team-serving.mjs` 同一条纪律）。

/** 值得花云端钱的**任务类型**（计划 §2.3 ① 的 {长复盘, 开放性提问, 局末教学} 在**本仓现有信号**下的落法）。 */
export const CLOUD_TASKS = Object.freeze(['review', 'lesson', 'open']);

/** 云端调用前必须还剩下的预算（毫秒）—— 计划 §2.3 ③ 的 2500ms。 */
export const CLOUD_MIN_REMAINING_MS = 2500;

/**
 * 把**现有的**路由信号落成任务类型（计划里那三个名字与仓内 `runtime.js:2883` 的
 * `review|training|battle` 不是一个快照，所以这里显式做映射，**不照抄计划里的词**）。
 *
 * 口径（ENGINE_HYPOTHESIS，判据里逐条钉住）：
 *   · `review`：teacher 档，或者玩家明确在要复盘（「复盘/回顾/整局/上一局/分析」）；
 *   · `lesson`：局末教学（teacher 档 + 有已结束的一局）；
 *   · `open`：陪练档里的**开放性提问**（问号/吗/多少/怎么/为什么）；
 *   · `battle`：局内取舍（其余一切在对局里的问句）—— **不花云端钱**；
 *   · `fact`：事实型短问（陪练档里不是开放提问的）—— 本地/规则就够。
 */
export function taskLabelOf({role = 'auto', message = '', hasFinishedMatch = false} = {}) {
  const text = String(message || '');
  const reviewAsked = /复盘|回顾|整局|上一场|上一局|分析|输在哪|为什么输/.test(text);
  if (hasFinishedMatch && (role === 'teacher' || role === 'auto')) return 'lesson';
  if (role === 'teacher' || reviewAsked) return 'review';
  const openShaped = /[？?]|吗|多少|怎么|为什么|为啥|能不能|要不要|该不该|哪个/.test(text);
  if (role === 'companion') return openShaped ? 'open' : 'fact';
  return openShaped ? 'battle' : 'fact';
}

/**
 * 云端这次该不该发。
 *
 * 三条**可判定**条件（全部成立才发），每一条都写进回执，便于事后核对：
 *   ① `CLOUD_TASKS.includes(task)`；
 *   ② 本地档不可用（`localAvailable === false`）**或**它这轮的产物被守卫判不合格（`localRejected === true`）；
 *   ③ `remainingMs > CLOUD_MIN_REMAINING_MS`。
 * 另加一条硬前提：`cloudConfigured === true`（没有 key 就谈不上"发不发"）。
 *
 * 缺省一律**不发**（`useCloud:false`）—— 省钱的默认方向与「未知 fail closed」一致。
 */
export function cloudDecision({task = null, cloudConfigured = false, localAvailable = false,
                              localRejected = false, remainingMs = 0} = {}) {
  const conditions = {
    cloud_configured: cloudConfigured === true,
    task_is_cloud_worthy: CLOUD_TASKS.includes(task),
    local_not_usable: localAvailable !== true || localRejected === true,
    budget_left: Number(remainingMs) > CLOUD_MIN_REMAINING_MS,
  };
  const failed = Object.entries(conditions).filter(([, ok]) => !ok).map(([name]) => name);
  const reason = failed.length === 0
    ? 'cloud-worthy'
    : (failed.includes('cloud_configured') ? 'cloud-not-configured'
      : failed.includes('task_is_cloud_worthy') ? 'task-not-cloud-worthy'
        : failed.includes('local_not_usable') ? 'local-usable-this-turn'
          : 'budget-too-tight');
  return {useCloud: failed.length === 0, reason, conditions,
    thresholds: {cloud_tasks: [...CLOUD_TASKS], min_remaining_ms: CLOUD_MIN_REMAINING_MS}};
}
