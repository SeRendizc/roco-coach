import test from 'node:test';
import assert from 'node:assert/strict';
import {battleAdvice} from '../src/coach/coach-advice.js';
import {runCoach,adviceLegalityReport} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {defenceMultiplier} from '../src/client/type-affinity.js';
const battle={battle_id:'energy-warning-public',state_version:1,turn:1,phase:'battle',result:null,
 self_active:0,self_energy_max:10,needs_replacement:[],
 self:[{pet_id:'pet_000001',name:'喵喵',types:['草系'],hp:495,max_hp:495,energy:10,alive:true},
 {pet_id:'pet_000007',name:'水蓝蓝',types:['水系'],hp:298,max_hp:298,energy:10,alive:true},
 {pet_id:'fire',name:'火花',types:['火系'],hp:400,max_hp:400,energy:10,alive:true}],
 foe:[{pet_id:'grass-foe',name:'魔力猫',types:['草系'],hp:405,max_hp:405,energy:10,alive:true}],
 legal:[{label:'抓挠',kind:'skill'},{label:'防御',kind:'skill'},{label:'换上第2位',kind:'switch'},{label:'换上第3位',kind:'switch'}]};
const plan={state_version:1,recommendation:'抓挠',damage_preview:{available:true,foe_hp:405,samples:[{label:'抓挠',min:35,max:50},{label:'防御',min:0,max:0}],formula_verified:false}};
test('full energy does not force the earlier full-health water slot over legal planner choice',()=>{
 assert.equal(battle.self[0].hp/battle.self[0].max_hp,1);assert.equal(battle.self[1].hp/battle.self[1].max_hp,1);
 assert.ok(battle.self[1].hp<battle.self[0].hp);
 assert.equal(defenceMultiplier(battle.self[1].types,'草系'),2);
 const advice=battleAdvice({battle,plan,message:'这一手的合法首选和主要风险是什么？'});
 assert.equal(advice.actionLabel,'抓挠',advice.text);assert.equal(advice.actionKind,'skill');
 assert.match(advice.risk,/能量.*10/);assert.match(advice.risk,/下一招.*未知|下一招.*不知道/);
 assert.doesNotMatch(advice.text,/厚的|更厚|直接倒|直接击倒|更安全|能量.*放得出重招/);
 assert.equal(adviceLegalityReport(advice).ok,true);
});
test('real runCoach without plan retains honest first-legal fallback and warning rather than switching',async()=>{
 const out=await runCoach({message:'这一手的合法首选和主要风险是什么？',role:'auto',
 context:{mode:'pvp-local',roco_battle:battle,profile:{pets:[]}},memory:freshMemory()});
 assert.equal(out.rocoAdvice.actionLabel,'抓挠',out.text);assert.notEqual(out.rocoAdvice.actionKind,'switch');
 assert.match(out.text,/没有.*估算|没有.*规划/);assert.match(out.text,/合法招里的第一条/);
 assert.match(out.rocoAdvice.risk,/能量/);assert.match(out.text,/下一招.*未知|下一招.*不知道/);
 assert.doesNotMatch(out.text,/厚的|更厚|直接倒|直接击倒|更安全/);
});
test('high energy warning does not override damage comparison when planner choice is absent',()=>{
 const advice=battleAdvice({battle,plan:{...plan,recommendation:undefined},message:'这一手怎么打？'});
 assert.equal(advice.actionLabel,'抓挠',advice.text);assert.match(advice.risk,/下一招.*未知/);
});
test('existing low-health switch and mandatory replacement keep their earlier evidence-based paths',()=>{
 const low={...battle,self:battle.self.map((p,i)=>i===0?{...p,hp:10}:p)};
 const lowAdvice=battleAdvice({battle:low,plan,message:'这一手怎么打？'});
 assert.equal(lowAdvice.kind,'switch-low-hp');assert.equal(lowAdvice.actionKind,'switch');
 const replacement={...low,phase:'replace',needs_replacement:['player'],self:low.self.map((p,i)=>i===0?{...p,hp:0,alive:false}:p),legal:battle.legal.filter(a=>a.kind==='switch')};
 const replacementAdvice=battleAdvice({battle:replacement,message:'这一手怎么打？'});
 assert.equal(replacementAdvice.kind,'replace-required');assert.equal(replacementAdvice.actionKind,'switch');
 assert.ok(replacementAdvice.legalActionId);assert.ok(replacementAdvice.evidence.legal.some(a=>a.legalActionId===replacementAdvice.legalActionId));
});
