// The API creates player.slots and team_members from the same ordered member list.
// Join those two parts of one receipt; request selected order is independently canonicalized.
export function bindWorkshopSlotIdentities(payload, {selected = [], ownedByInstance = new Map()} = {}) {
  const slots = Array.isArray(payload?.player?.slots) ? payload.player.slots : [];
  const identities = new WeakMap();
  const members = payload?.team_members;
  const filled = slots.filter((slot) => slot?.state === 'filled');
  if (!Array.isArray(members)) return {identities, slots: slots.slice(), available: false};
  const selectedSet = new Set(selected);
  const memberIds = members.map((row) => typeof row?.key === 'string' && row.key.startsWith('instance:')
    ? row.key.slice('instance:'.length) : null);
  const complete = selectedSet.size === selected.length
    && members.length === filled.length && members.length === selectedSet.size
    && memberIds.every((id) => id && selectedSet.has(id)) && new Set(memberIds).size === members.length;
  const blank = Object.freeze({instance: null, species: null});
  for (const slot of filled) {
    const at = Number.isInteger(slot.index) ? slot.index - 1 : -1;
    const member = at >= 0 ? members[at] : null;
    const instance = at >= 0 ? memberIds[at] : null;
    const known = instance ? ownedByInstance.get(instance) : null;
    const species = known?.speciesId ?? known?.species_id ?? null;
    identities.set(slot, complete && species && species === member?.species_id
      ? {instance, species} : blank);
  }
  const order = new Map(selected.map((id, at) => [id, at]));
  const ordered = slots.slice().sort((a, b) => {
    const ai = order.get(identities.get(a)?.instance) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(identities.get(b)?.instance) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || (a.index ?? 0) - (b.index ?? 0);
  });
  return {identities, slots: ordered,
    available: complete && filled.every((slot) => Boolean(identities.get(slot)?.instance))};
}
