import { execFileSync } from 'child_process';
import path from 'path';
import moment from 'moment';
import {
  ensureScheduleBucket,
  saveEntry,
  deleteEntry,
  fetchActualEvents,
  fetchSchedule,
  isLocalScheduleBucket,
} from '~/util/schedule';

const mockClient = {
  getBucketInfo: jest.fn(),
  getEvents: jest.fn(),
  getEvent: jest.fn(),
  createBucket: jest.fn(),
  insertEvents: jest.fn(),
  replaceEvents: jest.fn(),
  deleteEvent: jest.fn(),
  query: jest.fn(),
};
const mockLoadBuckets = jest.fn();
let mockBuckets: { id: string }[] = [];
jest.mock('~/util/awclient', () => ({ getClient: () => mockClient }));
jest.mock('~/stores/server', () => ({ useServerStore: () => ({ info: { hostname: 'self' } }) }));
jest.mock('~/stores/buckets', () => ({
  useBucketsStore: () => ({
    buckets: mockBuckets,
    loadBuckets: mockLoadBuckets,
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
    hosts: ['self'],
    bucketsWindow: () => ['window_self'],
    bucketsAFK: () => ['afk_self'],
  }),
}));

beforeEach(() => {
  Object.values(mockClient).forEach(fn => fn.mockReset());
  mockBuckets = [];
  mockLoadBuckets.mockReset().mockResolvedValue(undefined);
  mockClient.getBucketInfo.mockResolvedValue({ id: 'aw-webui-schedule_self' });
  mockClient.createBucket.mockResolvedValue(undefined);
  mockClient.query.mockResolvedValue([]);
});

it.each([
  { response: { status: 500 } },
  { response: { status: 401 } },
  { response: { status: 403 } },
  { code: 'ECONNABORTED' },
  new Error('offline'),
])('never creates a bucket after a failed read: %j', async error => {
  mockClient.getBucketInfo.mockRejectedValue(error);
  await expect(ensureScheduleBucket()).rejects.toBe(error);
  expect(mockClient.createBucket).not.toHaveBeenCalled();
});

it('trusts the server when the existing bucket is absent from a stale catalogue', async () => {
  await ensureScheduleBucket();
  expect(mockClient.createBucket).not.toHaveBeenCalled();
});

it('shares concurrent confirmed-404 checks and performs only one creation', async () => {
  let finish: () => void;
  mockClient.getBucketInfo.mockRejectedValue({ response: { status: 404 } });
  mockClient.createBucket.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  const first = ensureScheduleBucket();
  const second = ensureScheduleBucket();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mockClient.getBucketInfo).toHaveBeenCalledTimes(2);
  expect(mockClient.createBucket).toHaveBeenCalledTimes(1);
  finish();
  const ids = await Promise.all([first, second]);
  expect(ids[0]).toBe(ids[1]);
  expect(isLocalScheduleBucket(ids[0], 'aw-webui-schedule_self')).toBe(true);
  expect(ids[0]).not.toBe('aw-webui-schedule_self');
});

it('rechecks after failures and never caches a missing or existing bucket indefinitely', async () => {
  mockClient.getBucketInfo.mockRejectedValueOnce(new Error('offline'));
  await expect(ensureScheduleBucket()).rejects.toThrow('offline');
  await ensureScheduleBucket();
  await ensureScheduleBucket();
  expect(mockClient.getBucketInfo).toHaveBeenCalledTimes(3);
  expect(mockClient.createBucket).not.toHaveBeenCalled();
});

it('requires an origin for edits/deletes and strips frontend metadata from the payload', async () => {
  const entry = {
    id: 7,
    timestamp: '2026-11-18T09:00:00+08:00',
    duration: 3600,
    data: { title: 'meeting', uid: 'logical-id' },
  };
  await expect(saveEntry(entry)).rejects.toThrow('origin bucket');
  await expect(deleteEntry(entry)).rejects.toThrow('来源');
  await saveEntry({ ...entry, _bucket_id: 'aw-webui-schedule_peer' });
  expect(mockClient.replaceEvents).toHaveBeenCalledWith('aw-webui-schedule_peer', [entry]);
  expect(mockClient.createBucket).not.toHaveBeenCalled();
});

it('keeps day boundaries in local time across a DST change', async () => {
  if (!process.env.AW_SCHEDULE_DST) {
    execFileSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--selectProjects',
        'node',
        '--runInBand',
        '--coverage=false',
        '--runTestsByPath',
        __filename,
        '-t',
        'keeps day boundaries',
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, TZ: 'Europe/Stockholm', AW_SCHEDULE_DST: '1' },
        stdio: 'pipe',
        timeout: 30000,
      }
    );
    return;
  }
  const start = moment('2026-10-25');
  await fetchActualEvents(start, start.clone().add(2, 'days'));
  const [periods] = mockClient.query.mock.calls[0];
  expect(periods).toEqual([
    '2026-10-24T22:00:00+00:00/2026-10-25T23:00:00+00:00',
    '2026-10-25T23:00:00+00:00/2026-10-26T23:00:00+00:00',
  ]);
  expect(start.format('YYYY-MM-DD')).toBe('2026-10-25');
}, 35000);

it('clips a cross-midnight event to each query period so it is not counted twice', async () => {
  const event = { timestamp: '2026-11-16T23:00:00+08:00', duration: 7200, data: { app: 'Code' } };
  mockClient.query.mockResolvedValue([{ events: [event] }, { events: [event] }]);
  const events = await fetchActualEvents(moment('2026-11-16'), moment('2026-11-18'));
  expect(events.map(e => e.duration)).toEqual([3600, 3600]);
  expect(events.reduce((sum, e) => sum + e.duration, 0)).toBe(7200);
});

it('preserves both first saves from independent tabs on a server that overwrites created IDs', async () => {
  const stored = new Map<string, unknown[]>();
  const releases: (() => void)[] = [];
  mockClient.getBucketInfo.mockImplementation(async id => {
    if (!stored.has(id)) throw { response: { status: 404 } };
    return { id };
  });
  mockClient.createBucket.mockImplementation(
    id =>
      new Promise<void>(resolve =>
        releases.push(() => {
          // Model the dangerous Rust behavior: every POST replaces all contents.
          stored.set(id, []);
          resolve();
        })
      )
  );
  mockClient.insertEvents.mockImplementation(async (id, events) => stored.get(id).push(...events));
  let tabA: typeof import('~/util/schedule');
  let tabB: typeof import('~/util/schedule');
  jest.isolateModules(() => {
    tabA = require('~/util/schedule');
  });
  jest.isolateModules(() => {
    tabB = require('~/util/schedule');
  });
  const entry = { timestamp: '2026-11-18T09:00:00+08:00', duration: 3600, data: { title: 'A' } };
  const first = tabA.saveEntry(entry);
  const second = tabB.saveEntry({ ...entry, data: { title: 'B' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(releases).toHaveLength(2);
  releases[0]();
  await first;
  releases[1]();
  await second;
  const ids = mockClient.createBucket.mock.calls.map(([id]) => id);
  expect(new Set(ids).size).toBe(2);
  expect([...stored.values()].flat()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ data: { title: 'A' } }),
      expect.objectContaining({ data: { title: 'B' } }),
    ])
  );
});

it('reuses a live local generation and does not mistake synced copies for local storage', async () => {
  const id = 'aw-webui-schedule_self_generation-00000000-0000-4000-8000-000000000001';
  mockBuckets = [{ id: id + '-synced-from-peer' }, { id }];
  mockClient.getBucketInfo.mockRejectedValueOnce({ response: { status: 404 } });
  await expect(ensureScheduleBucket()).resolves.toBe(id);
  expect(mockClient.createBucket).not.toHaveBeenCalled();
  expect(isLocalScheduleBucket(id + '-synced-from-peer', 'aw-webui-schedule_self')).toBe(false);
  expect(isLocalScheduleBucket(id, 'aw-webui-schedule_other')).toBe(false);
});

it('appends a minimal deletion marker to the local bucket for a remote entry', async () => {
  const remote = {
    id: 7,
    timestamp: '2020-01-01T09:00:00Z',
    duration: 3600,
    data: { title: 'secret title', notes: 'secret notes', uid: 'deleted-uid' },
    _bucket_id: 'aw-webui-schedule_peer-synced-from-peer',
  };
  const before = Date.now();
  await deleteEntry(remote);
  expect(mockClient.deleteEvent).not.toHaveBeenCalled();
  expect(mockClient.replaceEvents).not.toHaveBeenCalled();
  const [bucket, [marker]] = mockClient.insertEvents.mock.calls[0];
  expect(bucket).toBe('aw-webui-schedule_self');
  expect(marker.data).toEqual({ deleted: true, uid: 'deleted-uid' });
  expect(marker.duration).toBe(0);
  expect(marker.id).toBeUndefined();
  expect(Date.parse(marker.timestamp)).toBeGreaterThanOrEqual(before);
});

it('refuses legacy deletion without a uid instead of hiding unrelated matching entries', async () => {
  await expect(
    deleteEntry({
      id: 7,
      timestamp: '2020-01-01T00:00:00Z',
      duration: 0,
      data: { title: 'legacy' },
      _bucket_id: 'aw-webui-schedule_self',
    })
  ).rejects.toThrow('缺少 uid');
  expect(mockClient.insertEvents).not.toHaveBeenCalled();
  expect(mockClient.deleteEvent).not.toHaveBeenCalled();
});

it('does not report deletion success if writing the tombstone fails', async () => {
  mockClient.insertEvents.mockRejectedValue(new Error('offline'));
  await expect(
    deleteEntry({
      id: 7,
      timestamp: '2020-01-01T00:00:00Z',
      duration: 0,
      data: { title: 'meeting', uid: 'u' },
      _bucket_id: 'aw-webui-schedule_peer',
    })
  ).rejects.toThrow('offline');
  expect(mockClient.deleteEvent).not.toHaveBeenCalled();
});

it('applies an out-of-range tombstone before filtering the viewed week', async () => {
  mockBuckets = [{ id: 'aw-webui-schedule_self' }, { id: 'aw-webui-schedule_peer' }];
  const event = {
    id: 7,
    timestamp: '2026-11-18T09:00:00+08:00',
    duration: 3600,
    data: { title: 'deleted', uid: 'u' },
  };
  mockClient.getEvents.mockImplementation(async id =>
    id.endsWith('self')
      ? [event]
      : [
          {
            id: 8,
            timestamp: '2026-12-01T00:00:00Z',
            duration: 0,
            data: { deleted: true, uid: 'u' },
          },
          {
            id: 9,
            timestamp: '2026-11-18T09:00:00+08:00',
            duration: 3600,
            data: { title: 'keep', uid: 'other' },
          },
          { id: 10, timestamp: '2026-12-01T00:00:00Z', duration: 3600, data: { title: 'outside' } },
        ]
  );
  const entries = await fetchSchedule(moment('2026-11-16'), moment('2026-11-23'));
  expect(entries.map(e => e.data.title)).toEqual(['keep']);
  expect(mockClient.getEvents).toHaveBeenCalledWith('aw-webui-schedule_self', { limit: -1 });
});

it.each(['unchanged', 'different uid', 'later timestamp', 'converted to tombstone'])(
  'page-load cleanup rechecks the original before physical deletion: %s',
  async state => {
    const original = {
      id: 7,
      timestamp: '2026-11-18T09:00:00Z',
      duration: 3600,
      data: { title: 'meeting', uid: 'u' },
    };
    const marker = {
      id: 8,
      timestamp: '2026-11-18T10:00:00Z',
      duration: 0,
      data: { deleted: true, uid: 'u' },
    };
    mockBuckets = [{ id: 'aw-webui-schedule_self' }, { id: 'aw-webui-schedule_peer' }];
    mockClient.getEvents.mockImplementation(async id =>
      id.endsWith('self') ? [original] : [marker]
    );
    mockClient.getEvent.mockResolvedValue(
      state === 'different uid'
        ? { ...original, data: { title: 'new', uid: 'new' } }
        : state === 'later timestamp'
        ? { ...original, timestamp: '2026-11-18T11:00:00Z' }
        : state === 'converted to tombstone'
        ? marker
        : original
    );
    const output = await fetchSchedule(moment('2026-11-16'), moment('2026-11-23'), {
      cleanup: true,
    });
    expect(output).toEqual([]);
    expect(mockClient.insertEvents).toHaveBeenCalledWith('aw-webui-schedule_self', [
      expect.objectContaining({ data: { deleted: true, uid: 'u' } }),
    ]);
    if (state === 'unchanged')
      expect(mockClient.deleteEvent).toHaveBeenCalledWith('aw-webui-schedule_self', 7);
    else expect(mockClient.deleteEvent).not.toHaveBeenCalled();
  }
);

it('reports cleanup failure separately and still hides deleted entries', async () => {
  const original = {
    id: 7,
    timestamp: '2026-11-18T09:00:00Z',
    duration: 3600,
    data: { title: 'meeting', uid: 'u' },
  };
  const marker = {
    id: 8,
    timestamp: '2026-11-18T10:00:00Z',
    duration: 0,
    data: { deleted: true, uid: 'u' },
  };
  mockBuckets = [{ id: 'aw-webui-schedule_self' }, { id: 'aw-webui-schedule_peer' }];
  mockClient.getEvents.mockImplementation(async id =>
    id.endsWith('self') ? [original] : [marker]
  );
  const error = new Error('offline');
  mockClient.insertEvents.mockRejectedValue(error);
  const onCleanupError = jest.fn();
  await expect(
    fetchSchedule(moment('2026-11-16'), moment('2026-11-23'), { cleanup: true, onCleanupError })
  ).resolves.toEqual([]);
  expect(onCleanupError).toHaveBeenCalledWith(error);
  expect(mockClient.deleteEvent).not.toHaveBeenCalled();
});

it('cleans a future schedule on page load while retaining its local tombstone and synced original', async () => {
  const original = {
    id: 7,
    timestamp: '2026-11-19T22:00:00+08:00',
    duration: 3600,
    data: { title: 'tonight', uid: 'future-uid' },
  };
  const marker = {
    id: 8,
    timestamp: '2026-11-19T15:40:00+08:00',
    duration: 0,
    data: { deleted: true, uid: 'future-uid' },
  };
  mockBuckets = [
    { id: 'aw-webui-schedule_self' },
    { id: 'aw-webui-schedule_peer-synced-from-peer' },
  ];
  mockClient.getEvents.mockImplementation(async id =>
    id.endsWith('self') ? [original, marker] : [{ ...original, id: 17 }]
  );
  mockClient.getEvent.mockResolvedValue(original);
  await expect(
    fetchSchedule(moment('2026-11-16'), moment('2026-11-23'), { cleanup: true })
  ).resolves.toEqual([]);
  expect(mockClient.deleteEvent.mock.calls).toEqual([['aw-webui-schedule_self', 7]]);
  expect(mockClient.insertEvents).not.toHaveBeenCalled();
});
