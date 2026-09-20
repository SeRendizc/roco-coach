// Who may receive tactical help, and when.
//
// The only mode that mutes the coach is online competitive play (`pvp-live`):
// there the opponent is a separate account and live tactical help would give
// one side an advantage the other cannot have.
//
// Local versus (`pvp-local`) is NOT muted, whoever sits opposite. It is a
// demo/learning surface on one device: the coach belongs to the player, the
// opponent can consult the same coach when the device is handed over, and the
// one line that actually matters is never crossed anyway - the coach never
// reads the opponent's pending action, which tests assert.
//
// Muting local versus was an over-reach in an earlier revision: it disabled the
// 军师 in exactly the 对战 scenario the task asks for, and it was incoherent -
// the AI opponent exists precisely to stand in for a human, so the two had to
// behave the same way.
const RANKED_MODES=['pvp-live'];
export function isLiveMatch(context){
  const modes=[context?.mode,context?.battle?.mode];
  if(!modes.some(m=>RANKED_MODES.includes(m)))return false;
  const ended=context?.battle?.result||context?.battle?.phase==='ended';
  return !ended;
}
export function isVersusMode(mode){return mode==='pvp-local'||mode==='pvp-live';}

// P01：局内主动干预的第一道硬门控。
//
// 「谁可以收到战术帮助」这一层本来就在本文件，所以模式限制也留在这里，而不是散进
// experience.js 的评分里。返回 null 表示通过；返回字符串就是必须沉默的门控标识。
// 关键性质：**这不参与打分**。评分函数（experience.shouldIntervene）只能在这一层
// 之后运行，因此任何 reward / 权重 / 阈值都不可能把线上竞技或已结束的对局换回来说话。
export function interventionPolicyGate(context){
 const battle=context?.battle||null;
 // 已经结束的对局：不是「安静一点」，而是交给复盘通道，赛中没有可说的一手。
 if(context?.ended===true||battle?.phase==='ended'||battle?.result)return 'ended';
 // 线上竞技进行中：对手是另一个账号，赛中任何战术帮助都会给一方不公平的优势。
 if(isLiveMatch({mode:context?.mode,battle}))return 'pvp-live';
 return null;
}
