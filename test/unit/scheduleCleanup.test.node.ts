import {
  planScheduleCleanup,
  runScheduleCleanup,
  visibleScheduleRecords,
} from '~/util/scheduleProtocol';

const now = Date.parse('2026-11-19T00:00:00Z');
const localId = 'aw-webui-schedule_self';
const live = {
  id: 7,
  timestamp: '2026-11-18T09:00:00Z',
  duration: 3600,
  data: { title: 'meeting', uid: 'u' },
  _bucket_id: localId,
};
const marker = {
  id: 8,
  timestamp: '2026-11-18T10:00:00Z',
  duration: 0,
  data: { deleted: true, uid: 'u' },
  _bucket_id: 'aw-webui-schedule_peer-synced-from-peer',
};

it.each([
  [live, marker],
  [marker, live],
])('deletion wins independently of record ordering: %j', (...records) => {
  expect(visibleScheduleRecords(records as any)).toEqual([]);
});

it('never hides another uid or a same-looking legacy entry', () => {
  expect(
    visibleScheduleRecords([
      live,
      marker,
      { ...live, data: { title: 'meeting', uid: 'other' } },
      { ...live, data: { title: 'meeting' } },
    ]).map(e => e.data.uid)
  ).toEqual(['other', undefined]);
});

it('plans only content older than its tombstone in local buckets, retaining tombstones and synced originals', () => {
  const records = [
    live,
    marker,
    { ...live, _bucket_id: 'aw-webui-schedule_self-synced-from-peer' },
    { ...live, data: { title: 'keep', uid: 'other' } },
  ];
  expect(planScheduleCleanup(records, localId)).toEqual({ guards: ['u'], deletions: [live] });
  expect(
    planScheduleCleanup([live, { ...marker, timestamp: '2026-11-18T00:00:00Z' }], localId).deletions
  ).toEqual([]);
});

it('writes a durable local guard before removing the original payload', async () => {
  const calls: string[] = [];
  const write = jest.fn(async (_id, guards) => {
    expect(guards[0].data).toEqual({ deleted: true, uid: 'u' });
    calls.push('guard');
  });
  const remove = jest.fn(async () => {
    calls.push('delete');
    return true;
  });
  await expect(
    runScheduleCleanup(
      [live, marker],
      localId,
      { writeGuards: write, deleteIfUnchanged: remove },
      now
    )
  ).resolves.toEqual({ deleted: 1, guardsWritten: 1 });
  expect(calls).toEqual(['guard', 'delete']);
  expect(write).toHaveBeenCalledWith(localId, expect.any(Array));
});

it('does not physically delete anything when guard persistence fails', async () => {
  const remove = jest.fn();
  await expect(
    runScheduleCleanup(
      [live, marker],
      localId,
      {
        writeGuards: jest.fn().mockRejectedValue(new Error('offline')),
        deleteIfUnchanged: remove,
      },
      now
    )
  ).rejects.toThrow('offline');
  expect(remove).not.toHaveBeenCalled();
});

it('keeps suppression after old content is cleaned and an offline peer returns it', () => {
  const guard = { ...marker, _bucket_id: localId, timestamp: new Date(now).toISOString() };
  expect(
    visibleScheduleRecords([guard, { ...live, _bucket_id: 'aw-webui-schedule_peer' }])
  ).toEqual([]);
});

it('reuses a local guard and never plans tombstone deletion, even years later', () => {
  const localMarker = { ...marker, _bucket_id: localId };
  expect(planScheduleCleanup([live, localMarker], localId)).toEqual({
    guards: [],
    deletions: [live],
  });
});
