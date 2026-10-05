import {runCoach,activeMatchIdOf} from '../../../../src/coach/runtime.js';
import {freshMemory} from '../../../../src/coach/memory.js';
const memory=freshMemory();memory.events=[{id:'old',result:'loss',turns:7,stage:'PREVIOUS-SCOPE-TAG',turnLog:[]}];
const context={mode:'camp',roco_battle:{battle_id:'new',state_version:2,turn:1,phase:'battle',self:[{pet_id:'a',name:'喵喵',hp:100,max_hp:100}],self_active:0,legal:[{kind:'skill',label:'防御'}]},lastMatch:{id:'old',result:'loss',turns:7,stage:'PREVIOUS-SCOPE-TAG',turnLog:[]},matchScope:'previous'};
for(const message of ['这回合怎么办','上一局打得怎么样']){const a=await runCoach({message,context,memory,conversation:[]});console.log(JSON.stringify({message,activeId:activeMatchIdOf(context),text:a.text,route:a.route,advice:!!a.rocoAdvice}));}
