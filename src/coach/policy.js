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
