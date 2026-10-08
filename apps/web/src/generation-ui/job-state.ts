/** Poll responses may predate a mutation response or temporarily omit its new job. */
export function mergeJobSnapshots<T extends { id: string; updatedAt: string; createdAt: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) {
    const existing = merged.get(job.id);
    if (!existing || job.updatedAt > existing.updatedAt) merged.set(job.id, job);
  }
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
