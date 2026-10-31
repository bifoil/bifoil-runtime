// Transient indexes accelerate primitive keys while preserving insertion order.
// Composite keys share a conservative bucket and still use structural equality.
// Indexes hold positions, never VM references, and are excluded from checkpoints.
const indexes = new WeakMap();

function bucket(key) {
  if (key.kind === "int" || key.kind === "float") return "number:" + key.value;
  if (key.kind === "char" || key.kind === "string") return "text:" + key.value;
  if (key.kind === "boolean") return "boolean:" + key.value;
  if (key.kind === "null" || key.kind === "unit") return key.kind;
  return "composite";
}

export function keyCandidates(object, key) {
  const storage = object.kind === "map" ? object.entries : object.items;
  let index = indexes.get(object);
  if (!index || index.storage !== storage || index.count > storage.length) {
    index = { storage, count: 0, buckets: new Map() };
    indexes.set(object, index);
  }
  // Construction and insertion append keys. Removals explicitly invalidate the
  // index because surviving positions move, even if a later insertion restores size.
  while (index.count < storage.length) {
    const position = index.count++;
    const item = object.kind === "map" ? storage[position][0] : storage[position];
    const hash = bucket(item);
    let positions = index.buckets.get(hash);
    if (!positions) index.buckets.set(hash, (positions = []));
    positions.push(position);
  }
  return index.buckets.get(bucket(key)) ?? [];
}

export function findKey(machine, object, key) {
  for (const position of keyCandidates(object, key)) {
    const candidate = object.kind === "map" ? object.entries[position][0] : object.items[position];
    if (machine.equal(candidate, key)) return position;
  }
  return -1;
}

export function invalidateKeys(object) {
  indexes.delete(object);
}
