// Preserve only metadata already present in the engine's public view.
// Callers must never pass a private state or fill gaps from a catalog.
export function publicSkillMetadata(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const key of ['skill_id', 'name', 'element']) {
    if (typeof row[key] === 'string' && row[key]) out[key] = row[key].slice(0, 80);
  }
  for (const key of ['energy', 'power']) {
    if (Number.isFinite(row[key]) && row[key] >= 0) out[key] = row[key];
  }
  return Object.keys(out).length ? out : null;
}

export function publicLegalMetadata(action) {
  const out = {};
  if (!action || typeof action !== 'object') return out;
  for (const key of ['skill_id', 'item_id']) {
    if (typeof action[key] === 'string' && action[key]) out[key] = action[key].slice(0, 80);
  }
  if (Number.isInteger(action.target_index) && action.target_index >= 0) out.target_index = action.target_index;
  const skill = publicSkillMetadata(action.skill);
  if (skill) out.skill = skill;
  return out;
}
