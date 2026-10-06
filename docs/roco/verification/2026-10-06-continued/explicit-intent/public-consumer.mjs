import {runCoach} from '../../../../../src/coach/runtime.js';
import {freshMemory} from '../../../../../src/coach/memory.js';
const battle={battle_id:'explicit-intent',state_version:1,turn:1,phase:'battle',result:null,self_active:0,
 self:[{pet_id:'pet_000001',name:'喵喵',types:['草系'],hp:366,max_hp:366,energy:6,alive:true},
 {pet_id:'pet_000007',name:'水蓝蓝',types:['水系'],hp:366,max_hp:366,energy:6,alive:true},
 {pet_id:'pet_000417',name:'缇塔',types:['机械系'],hp:345,max_hp:345,energy:6,alive:true}],
 foe:[{pet_id:'pet_000004',name:'火花',types:['火系'],hp:366,max_hp:366,energy:6,alive:true}],
 legal:[{label:'抓挠',kind:'skill'},{label:'防御',kind:'skill'},{label:'换上第2位',kind:'switch'}],
 affinity:{source:'public-current-fire',vs_types:['火系'],rows:[{pet_id:'pet_000001',multiplier:2,vs_type:'火系',known:true},{pet_id:'pet_000007',multiplier:0.5,vs_type:'火系',known:true},{pet_id:'pet_000417',multiplier:1,vs_type:'火系',known:true}]}};
const questions=['那只比较喵喵和水蓝蓝对光系的承伤倍率，不比较当前火花。','喵喵光系承伤0.5与缇塔1如何比较？如果迪莫的招式不是光系呢？','现在第1回合对火花，这一手的合法首选和主要风险是什么？'];
const results=[];
for(const message of questions){ const out=await runCoach({message,role:'auto',context:{mode:'battle',matchScope:'current',roco_battle:battle,profile:{pets:battle.self}},memory:freshMemory()});results.push({message,route:out.route,provider:out.provider,text:out.text,advice:out.rocoAdvice});}
console.log(JSON.stringify({scope:'public runCoach / localProvider, no real model or browser',battle,results},null,2));
