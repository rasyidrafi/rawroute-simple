/** Summarize committed edits without ever serializing the collection values. */
export function collectionChanges<T>(before: T[], after: T[]) {
  const identity = (item: T): unknown => item && typeof item === "object" && "id" in item ? item.id : item;
  const previous = new Map<unknown, { items: T[]; used: number }>();
  for (const item of before) {
    const id = identity(item);
    const group = previous.get(id) ?? { items: [], used: 0 };
    group.items.push(item);
    previous.set(id, group);
  }
  let added = 0;
  let updated = 0;
  for (const item of after) {
    const group = previous.get(identity(item));
    if (!group || group.used === group.items.length) added++;
    else if (group.items[group.used++] !== item) updated++;
  }
  const removed = before.length - (after.length - added);
  const reordered = added === 0 && removed === 0 && before.some((item, index) => identity(item) !== identity(after[index]!));
  return { added, removed, updated, reordered };
}
