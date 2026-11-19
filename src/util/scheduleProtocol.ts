// Tombstone semantics shared by display filtering and page-load maintenance.
export interface ScheduleRecord {
  id?: number;
  timestamp: string | Date;
  duration: number;
  data: { title?: string; uid?: string; deleted?: boolean; allDay?: boolean };
  _bucket_id?: string;
}
export const SCHEDULE_PREFIX = 'aw-webui-schedule_';

export function isLocalScheduleBucket(id: string, localId: string): boolean {
  if (id === localId) return true;
  const prefix = localId + '_generation-';
  return (
    id.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id.slice(prefix.length)
    )
  );
}

export function scheduleRecordUid(record: ScheduleRecord): string | undefined {
  const uid = record?.data?.uid;
  return typeof uid === 'string' && uid.trim().length > 0 ? uid : undefined;
}

export function isScheduleTombstone(record: ScheduleRecord): boolean {
  return record?.data?.deleted === true && !!scheduleRecordUid(record);
}

export function visibleScheduleRecords<T extends ScheduleRecord>(records: T[]): T[] {
  // Deletion wins over every live version, irrespective of ordering/date.
  const deleted = new Set(records.filter(isScheduleTombstone).map(scheduleRecordUid));
  return records.filter(
    record =>
      record?.data?.deleted !== true &&
      typeof record?.data?.title === 'string' &&
      !!record.data.title &&
      !deleted.has(scheduleRecordUid(record))
  );
}

export function planScheduleCleanup<T extends ScheduleRecord>(records: T[], localId: string) {
  // The event timestamp is its scheduled start, not its creation time.
  // Permanent UID tombstones suppress future entries and later edits alike.
  const deletedUids = new Set(records.filter(isScheduleTombstone).map(scheduleRecordUid));
  const localGuards = new Set(
    records
      .filter(
        record =>
          isScheduleTombstone(record) &&
          record._bucket_id &&
          isLocalScheduleBucket(record._bucket_id, localId)
      )
      .map(scheduleRecordUid)
  );
  const deletions = records.filter(
    record =>
      record?.data?.deleted !== true &&
      record.id !== undefined &&
      record._bucket_id &&
      isLocalScheduleBucket(record._bucket_id, localId) &&
      deletedUids.has(scheduleRecordUid(record))
  );
  const guards = [...new Set(deletions.map(scheduleRecordUid))].filter(
    uid => !localGuards.has(uid)
  );
  return { guards, deletions };
}

export async function runScheduleCleanup<T extends ScheduleRecord>(
  records: T[],
  localId: string,
  adapter: {
    writeGuards(bucketId: string, markers: ScheduleRecord[]): Promise<unknown>;
    deleteIfUnchanged(record: T): Promise<boolean>;
  },
  nowMs = Date.now()
) {
  const plan = planScheduleCleanup(records, localId);
  if (plan.guards.length) {
    // Make the deletion durable locally before removing any original content.
    // Retain guards forever; an offline peer may return arbitrarily late.
    await adapter.writeGuards(
      plan.deletions[0]._bucket_id,
      plan.guards.map(uid => ({
        timestamp: new Date(nowMs).toISOString(),
        duration: 0,
        data: { deleted: true, uid },
      }))
    );
  }
  let deleted = 0;
  for (const record of plan.deletions) {
    if (await adapter.deleteIfUnchanged(record)) deleted++;
  }
  return { deleted, guardsWritten: plan.guards.length };
}
