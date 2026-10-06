import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/client/roco.js',import.meta.url),'utf8');
const htmlStart=source.indexOf('function skillSlotHtml('),htmlEnd=source.indexOf('\n/**',htmlStart);
const html=vm.runInNewContext(source.slice(htmlStart,htmlEnd)+';skillSlotHtml',{escapeAttr:String,escapeHtml:String,categoryCn:String});
const detailsStart=source.indexOf('const B3_SKILL_SUPPORT_TEXT ='),detailsEnd=source.indexOf('let b3SkillDetailEl',detailsStart);
const details=vm.runInNewContext(source.slice(detailsStart,detailsEnd)+';b3SkillDetailRows');
const note='引擎会结算这条效果。',gap='这招有一部分引擎还不会算：1号或3号位时能耗减2';
const slot=support=>({move:{name:'测试技能',skill_id:'sample',desc:'技能说明'},action:{skill_id:'sample'},cost:2,enough:true,damage:12,damageVerified:false,support});
test('actual skill HTML hides normal warning but keeps gap, estimate and expandable source',()=>{
 const supported={tier:'SIMULATABLE_UNVERIFIED',settled:true,note};const result=html(slot(supported),[],false);
 assert.ok(!result.includes('data-roco-skill-support="yes"'));assert.match(result,/预计 12（未核验）/);assert.ok(result.slice(result.indexOf('<details')).includes(note));
 for(const tier of ['PARTIAL','KNOWLEDGE_ONLY']){const warning=html(slot({tier,note:gap}),[],false);assert.ok(warning.includes('data-roco-skill-support="yes"'));assert.ok(warning.includes(gap));}
 const rows=details({},{support:{tier:'PARTIAL',note:gap}});assert.ok(rows.some(r=>r[1]===gap));
});
test('actual reused battle slot removes supported warning and retains exact incomplete note',()=>{
 const start=source.indexOf('    const supportNote =',source.indexOf('const isMagicNew'));
 const end=source.indexOf('    // 注意：这里',start);let attached=null;
 const slot={querySelector:()=>attached,appendChild:el=>{attached=el;}};
 const document={createElement:()=>({dataset:{},style:{},remove(){attached=null;}})};
 const paint=support=>vm.runInNewContext(source.slice(start,end),{act:{support},slot,document});
 paint({tier:'PARTIAL',note:gap});assert.equal(attached.textContent,gap);
 paint({tier:'FULL_VERIFIED',settled:true,note});assert.equal(attached,null);
 paint({tier:'KNOWLEDGE_ONLY',note:gap});assert.equal(attached.textContent,gap);
});
