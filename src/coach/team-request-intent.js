// 配队命令是显式、可复算的产品操作。这里只读文本，不让模型临时编造约束或持有名单。
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const ids = value => Array.isArray(value) ? [...new Set(value.filter(one => typeof one === 'string' && one && one.length <= 100))] : [];
const union = (...values) => [...new Set(values.flat())];
export const TEAM_REQUEST_MODE = 'pvp-standard-six-pet';

export function teamWorkshopIdentity(workshop) {
  if (!obj(workshop) || workshop.mode !== TEAM_REQUEST_MODE) return null;
  const loadouts = obj(workshop.loadouts) ? Object.fromEntries(Object.keys(workshop.loadouts).sort()
    .map(key => [key, ids(workshop.loadouts[key])])) : {};
  return JSON.stringify({mode: workshop.mode, selected: ids(workshop.selected).sort(), locked: ids(workshop.locked).sort(), loadouts,
    goal: ['coverage', 'attack', 'bulk'].includes(workshop.goal) ? workshop.goal : 'coverage'});
}

export function parseTeamRequestIntent({message, workshop, previousRequest = null} = {}) {
  if (!teamWorkshopIdentity(workshop)) return {handled: false};
  const text = String(message ?? '').trim().split('\n回答要求：')[0];
  if (!text) return {handled: false};
  if (/不要(?:烦我|说了|解释|聊天|啰嗦)|别说话|不用回答|别烦/.test(text)) return {handled: false};
  const teamWords = /阵容|配队|队伍|一[套队]|[六6]只/.test(text);
  // “不要推荐”是停止，不把否定命令当成触发词。它不会清空已保留的筛选条件。
  if (/(?:不要|别|不用|不必|停止|先不|不想|不需要)(?:再|给我|帮我|进行|重新)*\s*(?:推荐|配队|生成阵容|换一套|换一批)(?:阵容|队伍|了|吧|啊|谢谢)?(?=[，,。！？?!\s]|$)/.test(text)) {
    return {handled: true, cancelled: true, message: '好，这次不生成新阵容，之前的配队条件保留。'};
  }
  const refresh = /换(?:一|几|三|3)?(?:套|批|队)|再(?:来|给我)(?:一|几|三|3)?套|再推荐(?:一|几|三|3)?(?:套|队)|更多(?:阵容|备选)/.test(text);
  const explicit = /(?:推荐|生成|给|来).{0,10}(?:阵容|队伍|[六6]只|一队)|(?:配|组)(?:个|一|一支|一套)?(?:队|阵容)|重新推荐|直接给我推荐/.test(text)
    || /^(?:帮我|给我|请|麻烦)?配队[吧啊。！？?!\s]*$/.test(text);
  const sizing = /^[六6][只个]?(?:啊|呀|呀啊|吧)?[。！？?!\s]*$/.test(text);
  if (/^(?:给我|我要|推荐|配|就|只要)?(?:三|3)只(?:啊|吧|呀|精灵|宠物)?[。！？?!\s]*$/.test(text)) {
    return {handled:true,clarify:true,message:'当前页面是六宠模式，我会按六只生成；如果要三只，请先切换到对应模式。'};
  }
  const constraint = /保留|锁定|必须带|一定要|带上|加上|不要(?:用|带|选)?|别用|排除|不带|去掉|不用/.test(text);
  const goal = /(?:速攻|进攻|攻击|输出)(?:高|强|多|取向|型|一点|一些)?|打得快/.test(text) ? 'attack'
    : /耐打|承伤|肉一点|更肉|稳一点|稳健|防守|防御取向/.test(text) ? 'bulk'
      : /属性(?:面|覆盖)|覆盖(?:广|全面)|全面|均衡/.test(text) ? 'coverage' : null;
  if (!(explicit || refresh || sizing || constraint || goal && previousRequest)) return {handled: false};
  if (!explicit && !refresh && !constraint && /多少|为什么|是什么|怎么|如何|吗[？?。!！\s]*$/.test(text)) return {handled: false};
  // 没有配队动词的图鉴/机制/局内动作问题仍交给原教练链。
  if (!explicit && !refresh && !sizing && !constraint && !previousRequest) return {handled: false};
  if (!explicit && !refresh && /(?:怎么|多少|什么|能否|吗|为什么|如何).*(?:配队|阵容)|(?:技能|性格|天分|种族值|进化).*(?:怎么|多少|什么|吗)/.test(text)) return {handled: false};
  if (/(?:不要|别|不用)(?:保留|锁定|排除)|取消(?:对|锁定|排除)|不一定要|不是(?:要|不要)/.test(text)) {
    return {handled: true, clarify: true, message: '这句里的保留和排除有歧义。请明确说“保留完整名字”或“不要完整名字”；这次先不改已有条件。'};
  }
  if (/(?:^|[，,\s])(?:3|三)只/.test(text)) {
    return {handled: true, clarify: true, message: '当前页面是六宠模式，我会按六只生成；如果要三只，请先切换到对应模式。'};
  }
  const prior = obj(previousRequest) ? previousRequest : {};
  const request = {mode: TEAM_REQUEST_MODE, selected: ids(workshop.selected), locked: ids(workshop.locked),
    loadouts: obj(workshop.loadouts) ? structuredClone(workshop.loadouts) : {},
    goal: goal ?? (['coverage', 'attack', 'bulk'].includes(workshop.goal) ? workshop.goal : prior.goal ?? 'coverage'),
    must_include: ids(Object.hasOwn(workshop,'must_include') ? workshop.must_include : prior.must_include),
    must_exclude: ids(Object.hasOwn(workshop,'must_exclude') ? workshop.must_exclude : prior.must_exclude),
    seenTeams: [...new Map((Object.hasOwn(workshop,'seenTeams') ? workshop.seenTeams : prior.seenTeams ?? []).map(ids)
      .map(team => [team.slice().sort().join('|'), team])).values()].slice(-80),
    refresh};
  if (goal && goal !== (prior.goal ?? workshop.goal ?? 'coverage')) request.seenTeams = [];
  const entityChanges = [];
  const command = /(保留|锁定|必须带|一定要|带上|加上|不要推荐|不要用|不要带|不要选|不要|别用|排除|不带|去掉|不用)\s*(.*?)(?=(?:保留|锁定|必须带|一定要|带上|加上|不要推荐|不要用|不要带|不要选|不要|别用|排除|不带|去掉|不用)|[，,；;。！？?!\n]|$)/g;
  for (const match of text.matchAll(command)) {
    const target = match[2].trim().replace(/(?:吧|啊|呀|哦|就好|即可|这只|这个)+$/g, '').trim();
    if (!target || /推荐|配队|阵容|队伍/.test(target)) continue;
    entityChanges.push({kind: /^(?:保留|锁定|必须带|一定要|带上|加上)$/.test(match[1]) ? 'include' : 'exclude', text: target});
  }
  if (constraint && !entityChanges.length && !explicit && !refresh) return {handled: false};
  return {handled: true, request, entityChanges, operation: refresh ? 'refresh' : 'recommend', teamWords,
    requireKnownEntity: constraint && entityChanges.every(one=>one.kind==='exclude') && !explicit && !refresh && !previousRequest && !teamWords};
}

function entityRows(owned) {
  return (Array.isArray(owned) ? owned : []).filter(obj).map(row => ({instance: row.select ?? row.instance_id ?? row.instance,
    species: row.group ?? row.species_id ?? row.species, name: row.name}));
}

export function resolveTeamEntityChanges({intent, owned = []} = {}) {
  if (!intent?.request) return {ok: false, error: '缺少配队请求'};
  const request = structuredClone(intent.request);
  const before = JSON.stringify([request.must_include.slice().sort(),request.must_exclude.slice().sort()]);
  const rows = entityRows(owned);
  const resolved = [];
  const lookup = text => {
    const instance = rows.find(row => row.instance === text);
    if (instance) return {id: instance.instance, species: instance.species};
    const matches = rows.filter(row => row.species === text || row.name === text);
    const species = [...new Set(matches.map(row => row.species).filter(Boolean))];
    if (species.length === 1) return {id: species[0], species: species[0]};
    if (species.length > 1) return {error: `“${text}”对应多个形态，请给完整形态名或个体编号`, needs: species};
    return {error: `完整持有里没有准确匹配“${text}”，请给完整名字或个体编号`, needs: [text]};
  };
  for (const change of intent.entityChanges ?? []) {
    const exact = lookup(change.text);
    const pieces = exact.id || exact.needs?.length > 1 ? [change.text] : change.text.split(/[、和及]/).map(one => one.trim()).filter(Boolean);
    for (const text of pieces) {
      const entity = lookup(text);
      if (entity.error) return {ok: false, error: entity.error, needs: entity.needs, request};
      if (resolved.some(one => one.species === entity.species && one.kind !== change.kind)) {
        return {ok:false,error:`同一句里同时要求保留和排除“${text}”，请明确选一个条件`,needs:[text],request};
      }
      resolved.push({...change, ...entity});
    }
  }
  const speciesOf = id => rows.find(row => row.instance === id)?.species ?? id;
  for (const change of resolved) {
    const same = id => id === change.id || speciesOf(id) === change.species;
    const addKey = change.kind === 'include' ? 'must_include' : 'must_exclude';
    const removeKey = change.kind === 'include' ? 'must_exclude' : 'must_include';
    request[removeKey] = request[removeKey].filter(id => !same(id));
    request[addKey] = union(request[addKey], [change.id]);
  }
  if (before !== JSON.stringify([request.must_include.slice().sort(),request.must_exclude.slice().sort()])) request.seenTeams = [];
  return {ok: true, request, resolved};
}
