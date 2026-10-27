import {readFileSync} from 'node:fs';

// Join only explicit game IDs in the frozen evolution graph. Names and stage
// numbers are not identity: equal names can be different forms.
export function buildEvolutionFamilyMetadata(catalogPets, communityPets) {
  const parents=new Map();
  const find=(id)=>{
    if(!parents.has(id))parents.set(id,id);
    if(parents.get(id)!==id)parents.set(id,find(parents.get(id)));
    return parents.get(id);
  };
  const join=(a,b)=>{const x=find(a),y=find(b);if(x!==y)parents.set(x<y?y:x,x<y?x:y);};
  for(const [key,pet] of Object.entries(communityPets??{})){
    const rings=Array.isArray(pet?.evolution)?pet.evolution:[];
    const ids=[...new Set(rings.flatMap(r=>Array.isArray(r)?r:[])
      .map(r=>String(r?.id??'')).filter(id=>/^\d+$/.test(id)))];
    const ownId=String(pet?.game_id??key);
    if(!ids.length||!ids.includes(ownId))continue;
    ids.forEach(id=>join(ids[0],id));
  }
  const families={};
  for(const pet of Object.values(catalogPets??{})){
    const id=String(pet?.game_id??'');
    if(typeof pet?.pet_id==='string'&&parents.has(id))families[pet.pet_id]=`hke:${find(id)}`;
  }
  return {ok:true,source:{id:'hke-2026-09-27',label:'社区图鉴进化链快照（参考，非官方文本）'},
    families,mappedSpecies:Object.keys(families).length,totalSpecies:Object.keys(catalogPets??{}).length};
}

let cached;
export function evolutionFamilyMetadata(){
  if(!cached){
    const read=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),'utf8'));
    const base=read('../../data/roco/normalized/roco-world-s4-2026-09-10/pets.json').pets;
    const playable=read('../../data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/pets.json').pets;
    const community=read('../../data/roco/derived/hke-2026-09-27/pets.json').pets;
    cached=buildEvolutionFamilyMetadata({...base,...playable},community);
  }
  return cached;
}
