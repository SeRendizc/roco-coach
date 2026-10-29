import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTeamRequestIntent,resolveTeamEntityChanges,teamWorkshopIdentity} from '../src/coach/team-request-intent.js';

const workshop={mode:'pvp-standard-six-pet',selected:[],locked:[],loadouts:{},goal:'coverage'};
const owned=[{select:'own-1',group:'pet_1',name:'水灵'},{select:'own-2',group:'pet_1',name:'水灵'},
  {select:'own-3',group:'pet_3',name:'火神'},{select:'own-4',group:'pet_4',name:'海枝枝'},
  {select:'own-5',group:'pet_5',name:'海枝枝'}];
const parse=(message,previousRequest=null,w=workshop)=>parseTeamRequestIntent({message,workshop:w,previousRequest});

test('已知六宠直接推荐与尺寸跟进，不反问3还是6',()=>{
 for(const message of ['推荐个阵容','帮我配队','给我6只','6只啊','？你直接给我推荐啊','重新推荐']){
  const intent=parse(message);assert.equal(intent.handled,true,message);assert.equal(intent.request.mode,workshop.mode,message);
 }
 assert.equal(parse('3只啊').clarify,true);
});

test('生成与换批明确区分，调整目标会清旧seen',()=>{
 assert.equal(parse('重新推荐').request.refresh,false);
 assert.equal(parse('换一套').request.refresh,true);
 const seen=[['own-1','own-2','own-3','own-4','own-5','own-6']];
 const intent=parse('输出高一点',{...workshop,seenTeams:seen});
 assert.equal(intent.request.goal,'attack');assert.deepEqual(intent.request.seenTeams,[]);
});

test('普通闲聊、事实和当前局内动作不被配队意图抢走',()=>{
 for(const text of ['你好','水灵是什么属性','这回合换谁','火神技能是什么','6能量够吗','我攻击是多少','不要烦我']){
  assert.equal(parse(text,workshop).handled,false,text);
 }
 assert.equal(parseTeamRequestIntent({message:'推荐个阵容',workshop:null}).handled,false);
});

test('否定推荐停止生成；不要推荐某宠则是排除，不吞掉对象',()=>{
 for(const text of ['不要推荐阵容','别帮我配队了','我不想配队','不用推荐了'])assert.equal(parse(text).cancelled,true,text);
 const intent=parse('不要推荐火神',workshop);assert.equal(intent.cancelled,undefined);
 const result=resolveTeamEntityChanges({intent,owned});assert.equal(result.ok,true);assert.deepEqual(result.request.must_exclude,['pet_3']);
 for(const text of ['不要保留水灵','不要排除火神','取消锁定水灵'])assert.equal(parse(text,workshop).clarify,true,text);
});

test('完整名字按物种约束，指定实例则保持实例，不猜同名形态',()=>{
 const water=resolveTeamEntityChanges({intent:parse('保留水灵'),owned});
 assert.deepEqual(water.request.must_include,['pet_1']);
 const exact=resolveTeamEntityChanges({intent:parse('保留own-2'),owned});
 assert.deepEqual(exact.request.must_include,['own-2']);
 const ambiguous=resolveTeamEntityChanges({intent:parse('保留海枝枝'),owned});
 assert.equal(ambiguous.ok,false);assert.deepEqual(ambiguous.needs,['pet_4','pet_5']);
 const unknown=resolveTeamEntityChanges({intent:parse('保留小水灵'),owned});
 assert.equal(unknown.ok,false);assert.match(unknown.error,/准确匹配/);
});

test('多轮包含/排除保留；明示反向约束移除旧相反条件，同句冲突澄清',()=>{
 const first=resolveTeamEntityChanges({intent:parse('保留水灵'),owned}).request;
 const second=resolveTeamEntityChanges({intent:parse('不要火神',first),owned}).request;
 const next=parse('换一套',second).request;
 assert.deepEqual(next.must_include,['pet_1']);assert.deepEqual(next.must_exclude,['pet_3']);
 const reverse=resolveTeamEntityChanges({intent:parse('带上火神',second),owned});
 assert.deepEqual(reverse.request.must_exclude,[]);assert.ok(reverse.request.must_include.includes('pet_3'));
 assert.equal(resolveTeamEntityChanges({intent:parse('保留水灵，不要水灵'),owned}).ok,false);
});

test('身份仅从当前选人/锁定/四招/目标组成，不相信客户端自称相同selectionKey',()=>{
 const a={...workshop,selectionKey:'forged'};
 assert.notEqual(teamWorkshopIdentity(a),teamWorkshopIdentity({...a,selected:['own-1']}));
 assert.notEqual(teamWorkshopIdentity(a),teamWorkshopIdentity({...a,goal:'attack'}));
 assert.notEqual(teamWorkshopIdentity(a),teamWorkshopIdentity({...a,loadouts:{pet_1:['s1','s2','s3','s4']}}));
});

test('客户端明确给出的空条件和空seen优先；只有省略字段才继承会话',()=>{
 const prior={must_include:['pet_1'],must_exclude:['pet_3'],seenTeams:[['own-1','own-2','own-3','own-4','own-5','own-6']]};
 const inherited=parse('换一套',prior).request;assert.deepEqual(inherited.must_exclude,['pet_3']);assert.equal(inherited.seenTeams.length,1);
 const clear=parse('换一套',prior,{...workshop,must_include:[],must_exclude:[],seenTeams:[]}).request;
 assert.deepEqual(clear.must_include,[]);assert.deepEqual(clear.must_exclude,[]);assert.deepEqual(clear.seenTeams,[]);
});
