/**
 * **本问句该依据哪一局**：当前局优先（P1-B，task-46，lead-mac 报的「新局被上一局抢答」）。
 *
 * 为什么单独一个文件：这个判定要被 `runtime.js`、`companion.js`、`teacher.js`、浏览器那层共用，
 * 而 `runtime.js` 已经 import 了 `companion.js`/`teacher.js` ⇒ 反过来 import 会成环。
 * 所以判定放在这个**零依赖的叶子模块**里，谁都能 import，且**只有这一处定义**。
 *
 * 规则（所有读点共用，不许各写各的）：
 *   ① 当前局存在（进行中的 live / archive.current，或刚结束的当前局）⇒ `current`；
 *   ② 只有"明确问上一局"或"根本不存在当前局"时才回落 `previous` —— 下游**必须显式标注**
 *      「这是上一局」（`matchScope==='previous'` 就是那个标注信号）；
 *   ③ 两者都没有 ⇒ `scope:null`（不猜）。
 *
 * ⚠️ `lastMatch` 这个名字骗人：它其实是"**本问句依据的那一局**"（`buildContext` 里由
 * `summarizeMatch(source)` 得来）。旧兜底写的是 `previous || current`：只要调用方没把 `game`
 * 递进来（小芽面板 / 营地页那条路），而 archive 里既有进行中的 `current` 又有上一局的 `completed`，
 * 它就会挑**上一局**。实测原文见
 * `reports/roco/product-execution/crosscut/p1b-lastmatch-triage.md` §1。
 */

export function activeMatchOf({game=null,archive=null,message=''}={}){
 const hasHistory=(x)=>Array.isArray(x?.history)&&x.history.length>0;
 const live=hasHistory(game)&&!game.result?game:null;                        // 进行中的当前局（宿主递了 game）
 const archived=hasHistory(archive?.current)?archive.current:null;           // archive 里的当前局（可能已结束）
 const previous=Array.isArray(archive?.completed)&&archive.completed.length?archive.completed.at(-1):null;
 const asksPrevious=/上一局|上一场|上个局/.test(String(message));
 if(asksPrevious&&previous)return {scope:'previous',match:previous,id:previous.id??null};   // 明确问上一局 ⇒ 允许回落
 const current=live??archived;
 if(current)return {scope:'current',match:current,id:current.id??null};                     // ① 当前局优先
 if(hasHistory(game)&&game.result)return {scope:'current',match:game,id:game.id??null};     // 刚结束的当前局仍算当前
 if(previous)return {scope:'previous',match:previous,id:previous.id??null};                 // ② 无当前局才回落
 return {scope:null,match:null,id:null};                                                    // ③ 都不存在
}

/**
 * **生效的作用域**：把"这个包里有没有实时局面"也算进来。
 *
 * 为什么不能只看 `matchScope`：`buildContext` 只拿得到 `game`/`archive`，而客户端（`roco.js`）
 * 是把实时局面放在 `context.roco_battle` 里加的。Codex 报的第二条入口正是"面板没给 `game`、
 * archive 里也没有 `current`，但 `roco_battle` 有值（turn=1）"——那种情况下 `matchScope` 可能是
 * `previous`，于是下游又去讲上一局。**`roco_battle` 本身就是"当前局存在"的证据**，这里统一收口。
 */
export function effectiveMatchScope(context={}){
 const liveBattle=context?.roco_battle&&typeof context.roco_battle==='object'?context.roco_battle:null;
 if(liveBattle)return 'current';
 return context?.matchScope??(context?.battle?'current':context?.lastMatch?'previous':null);
}

/**
 * 上下文里"当前依据的那一局"的 id。老形状（只有 `battle`/`lastMatch`）按 current 反推，
 * 这样模型路径上的历史会话不会因为新增字段而变味。
 */
export function activeMatchIdOf(context={}){
 const scope=effectiveMatchScope(context);
 if(scope==='previous')return context?.lastMatch?.id??null;
 if(scope==='current')return context?.roco_battle?.battle_id??context?.battle?.id??context?.roco_battle?.id??context?.lastMatch?.id??null;
 return null;
}

/** 这一次回答是不是在讲**上一局**（下游据此显式标注「上一局」）。 */
export function readsAsPreviousMatch(context={}){
 return effectiveMatchScope(context)==='previous';
}

/**
 * 宿主没给 `lastMatch` 时，要不要用本机记忆里的最后一条来补？（P1-B · 02 红线「不许显示上一局当本局」）
 *
 * 规则：
 *   · **有当前局**（`effectiveMatchScope==='current'`：宿主动局上下文口给了 `game`/`roco_battle`）⇒ **不补**；
 *   · 没有当前局 ⇒ 允许补，且**必须显式标成 `previous`** —— 下游（`teacher.reviewMatch`）据此在正文写「上一局：」；
 *   · 宿主已经给了 `lastMatch`、或磁盘上根本没有对局记录 ⇒ 什么都不做（不编）。
 *
 * 返回要写进上下文的 `{lastMatch, matchScope}`；不该补时返回 `null`。
 */
export function hydrationOfPreviousMatch(context={},events=[]){
 if(effectiveMatchScope(context)==='current')return null;
 if(context?.lastMatch)return null;
 if(!Array.isArray(events)||!events.length)return null;
 return {lastMatch:events[events.length-1],matchScope:'previous'};
}
