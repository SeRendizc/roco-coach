import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {publicReviewMoment, reviewMatch as nativeReview, teacherGoalLesson} from '../src/coach/teacher-review.js';
import {reviewMatch, matchPlayerSummary} from '../src/coach/teacher.js';
import {rocoGameView, rocoMatchReview} from '../src/coach/roco-experience.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/roco-review-public-live-20261027.json',import.meta.url),'utf8'));
const game=rocoGameView(fixture.lastLiveView,{matchId:'review-dev-replay'});

test('real local native receipts: a named skill, exact target slot and observed outcome come from the same round',()=>{
 const m=publicReviewMoment({events:fixture.events,game,turn:2});
 assert.equal(m.skillId,'skill_000340');
 assert.equal(m.action,'「仙人掌刺击」'); // self.skills[].name is the source, not a current legal action.
 assert.equal(m.targetSlot,0);
 assert.equal(m.damage,415);
 assert.equal(m.typeMultiplier,2);
 assert.equal(m.execution,'executed');
 assert.match(m.text,/第 2 回合/);
 assert.match(m.text,/对方第 1 位/); // final opponent field cannot identify that past opponent.
 assert.ok(m.anchors.every(i=>fixture.events[i].turn===2));
});

test('real native cancelled turn: no skill is invented, and the next step responds to action cancellation',()=>{
 const r=nativeReview({events:fixture.events,game,result:'loss',decisionRecords:[]});
 assert.equal(r.moment.turn,5);
 assert.equal(r.moment.execution,'cancelled');
 assert.match(r.playerSummary,/取消.*行动前已倒下/);
 assert.match(r.playerSummary,/63 点伤害/);
 assert.match(r.playerSummary,/技能名未知/);
 assert.match(r.playerSummary,/行动顺序和当前血线/);
 assert.doesNotMatch(r.playerSummary,/半.*回复药|一定.*换|因为.*输/);
 assert.ok(r.text.length>r.playerSummary.length);
 assert.ok(r.evidence.length>0);
});

test('removing multiplier or skill id must leave unknown, even with the same damage value',()=>{
 const events=structuredClone(fixture.events.filter(e=>e.turn===2));
 const attack=events.find(e=>e.kind==='damage'&&e.detail.side==='player');
 delete attack.detail.type_multiplier;delete attack.detail.skill_id;
 const m=publicReviewMoment({events,game,turn:2});
 assert.equal(m.damage,415);
 assert.equal(m.typeMultiplier,null);
 assert.equal(m.skillId,null);
 assert.match(m.text,/技能名.*属性倍率.*未知/);
 assert.doesNotMatch(m.text,/仙人掌刺击|倍率 2/);
});

test('unsettled added effects are reported rather than counted as successful',()=>{
 const m=publicReviewMoment({events:fixture.events,game,turn:3});
 assert.match(m.text,/附带效果未结算/);
 assert.equal(m.skillId,'skill_000246');
 assert.ok(m.anchors.some(i=>fixture.events[i].kind==='effects_registered_unsupported'));
});

test('an accepted request without an execution event does not establish success',()=>{
 const m=publicReviewMoment({events:[{turn:7,kind:'turn_start',detail:{}}],game,turn:7,decisionRecords:[]});
 assert.equal(m.execution,'unknown');
 assert.match(m.text,/执行结果未记录/);
 assert.equal(m.damage,null);
});

test('legacy summaries do not infer a skill or success from before-after hp',()=>{
 const r=reviewMatch({lastMatch:{id:'legacy',result:'loss',turnLog:[{turn:5,you:{name:'喵喵',hp:4,hpAfter:0},foe:{name:'水灵',hp:60,hpAfter:42},action:{kind:'skill'},events:[]}],keyTurns:[],counts:{}}});
 assert.match(r.playerSummary,/上一局/);
 assert.match(r.playerSummary,/第5回合.*喵喵.*水灵/);
 assert.match(r.playerSummary,/名字未知/);
 assert.match(r.playerSummary,/执行结果未记录/);
 assert.match(r.playerSummary,/其他合法选择和分支结果未保存/);
 assert.ok(r.text.includes('关键回合：'),'full original detailed review stays available');
});

test('recorded decision contrasts a real candidate but does not promise the whole game changes',()=>{
 const d={turn:4,situation:{playerPet:'火神',playerHp:30,enemyPet:'水灵',enemyHp:60},chosen:{name:'火焰',action:{kind:'skill',id:'a'}},options:[{name:'换上魔力猫',action:{kind:'switch',target:2}}],consequence:{cancelled:true}};
 const text=matchPlayerSummary({decision:d,outcome:'失利'});
 assert.match(text,/第4回合/);assert.match(text,/取消/);assert.match(text,/换上魔力猫/);
 assert.match(text,/不能保证/);
});

test('learning guidance no longer prescribes an unverified universal half-hp potion or immediate switch',()=>{
 assert.doesNotMatch(teacherGoalLesson('use-item-before-danger-line'),/掉下一半.*吃掉/);
 assert.match(teacherGoalLesson('use-item-before-danger-line'),/比较/);
 assert.match(teacherGoalLesson('switch-out-of-the-bad-matchup'),/是否可选|比较/);
 assert.match(teacherGoalLesson('treat-status-before-it-stacks'),/换人是否解除状态要看规则/);
});

test('native production assembly surfaces the short summary and retains full evidence',()=>{
 const {review}=rocoMatchReview({matchId:'review-dev-replay',finalView:fixture.finalView,lastLiveView:fixture.lastLiveView,events:fixture.events,result:'loss',decisionRecords:[]});
 assert.ok(review.playerSummary);
 assert.equal(review.displayText,review.playerSummary);
 assert.ok(review.text.length>review.displayText.length);
 assert.ok(review.evidence.some(e=>e.includes('63')));
});


test('a native KO without a matching fixed lesson still gets an evidence review without invented teaching credit',()=>{
 const events=fixture.events.filter(e=>[2,3].includes(e.turn));
 const r=nativeReview({events,game,result:'win',decisionRecords:[]});
 assert.ok(r);
 assert.equal(r.goal,null);
 assert.equal(r.summaryOnly,true);
 assert.equal(r.moment.turn,3);
 assert.match(r.playerSummary,/抓挠|附带效果未结算/);
 assert.equal(r.learning,null);
});
