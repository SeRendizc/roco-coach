const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

export function recommendationSelectionKey({mode,selected=[],locked=[],loadouts={}}={}){
 return JSON.stringify(stable({mode,selected,locked:[...locked].sort(),loadouts}));
}

export function recommendationConstraintKey(request={}){
 return JSON.stringify(stable({goal:request.goal??'coverage',must_include:[...(request.must_include??[])].sort(),
  must_exclude:[...(request.must_exclude??[])].sort()}));
}

export function validateRecommendationRows(alternative,ownedByInstance,locked=[]){
 const rows=alternative?.rows;
 if(!Array.isArray(rows)||rows.length!==6)return '这套方案没有完整的六只精灵。';
 if(new Set(rows.map(r=>r.instance)).size!==6||new Set(rows.map(r=>r.species)).size!==6)return '这套方案包含重复成员，不能采用。';
 for(const row of rows){
  const owned=ownedByInstance.get(row.instance);
  if(!owned||(owned.speciesId??owned.species_id)!==row.species)return '方案中的个体与当前盒子不一致，请重新推荐。';
  if(!Array.isArray(row.skills)||row.skills.length!==4||new Set(row.skills.map(s=>s.skill_id)).size!==4
    ||row.skills.some(s=>typeof s.skill_id!=='string'||!s.skill_id))return '方案中有精灵没有四个不同的技能，不能采用。';
 }
 if(locked.some(id=>!rows.some(row=>row.instance===id)))return '方案没有保留当前锁定成员，请重新推荐。';
 return null;
}
