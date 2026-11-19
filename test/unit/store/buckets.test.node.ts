import { setActivePinia, createPinia } from 'pinia';

import { useBucketsStore } from '~/stores/buckets';
import { useServerStore } from '~/stores/server';
import { IBucket } from '~/util/interfaces';

function bucket(partial: Partial<IBucket> & { id: string }): IBucket {
  return {
    hostname: 'erb-m2',
    type: 'currentwindow',
    data: {},
    last_updated: new Date('2026-09-16T00:00:00Z'),
    first_seen: new Date('2026-09-16T00:00:00Z'),
    ...partial,
  } as IBucket;
}

describe('bucketsByDevice', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useServerStore().$patch({
      info: {
        hostname: 'erb-m2',
        device_id: 'local-uuid',
        version: '0.14.0',
        testing: true,
      },
    });
  });

  test('falls back to hostname when data.device_id is missing', () => {
    const store = useBucketsStore();
    store.update_buckets([bucket({ id: 'aw-watcher-window_erb-m2' })]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.hostname).toBe('erb-m2');
    expect(device.device_id).toBe('erb-m2');
    expect(device.device_ids).toEqual(['erb-m2']);
    expect((device as { id?: string }).id).toBeUndefined();
  });

  test('exposes data.device_id when it differs from hostname', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({
        id: 'aw-watcher-window_erb-m2',
        data: { device_id: 'dev-uuid-1' },
      }),
    ]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.hostname).toBe('erb-m2');
    expect(device.device_id).toBe('dev-uuid-1');
    expect(device.hostname !== device.device_id).toBe(true);
    expect((device as { id?: string }).id).toBeUndefined();
  });

  test('prefers real UUID over hostname fallback in mixed group', () => {
    // A group where one bucket has no data.device_id (falls back to hostname)
    // and another has a real UUID. The group device_id must be the UUID so
    // the Buckets view label is visible (hostname !== device_id guard).
    const store = useBucketsStore();
    store.update_buckets([
      // Older bucket without device_id — would produce hostname fallback
      bucket({ id: 'aw-watcher-afk_erb-m2', type: 'afkstatus' }),
      // Newer bucket with a real UUID
      bucket({
        id: 'aw-watcher-window_erb-m2',
        data: { device_id: 'real-uuid-xyz' },
      }),
    ]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.hostname).toBe('erb-m2');
    expect(device.device_id).toBe('real-uuid-xyz');
    expect(device.hostname !== device.device_id).toBe(true);
  });

  test('hostname fallback loses to real UUID even when data.hostname differs in case', () => {
    // Regression guard: the UUID-vs-hostname comparison must be
    // case-insensitive against every hostname in the group.
    const store = useBucketsStore();
    store.update_buckets([
      bucket({
        id: 'aw-watcher-afk_erb-m2',
        type: 'afkstatus',
        data: { hostname: 'ERB-M2' }, // case-mismatched data.hostname
      }),
      bucket({
        id: 'aw-watcher-window_erb-m2',
        data: { device_id: 'real-uuid-xyz' },
      }),
    ]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.device_id).toBe('real-uuid-xyz');
    expect(device.hostname !== device.device_id).toBe(true);
  });

  test('UUID-shaped device_id wins even over a non-group hostname-like id', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({
        id: 'aw-watcher-afk_erb-m2',
        type: 'afkstatus',
        data: { device_id: 'other-host' }, // hostname-like, but not this group's hostname
      }),
      bucket({
        id: 'aw-watcher-window_erb-m2',
        data: { device_id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' },
      }),
    ]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.device_id).toBe('f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  });

  test('collects several device_ids on the same host', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({
        id: 'aw-watcher-window_erb-m2',
        data: { device_id: 'uuid-a' },
      }),
      bucket({
        id: 'aw-watcher-afk_erb-m2',
        type: 'afkstatus',
        data: { device_id: 'uuid-b' },
      }),
    ]);

    const device = Object.values(store.bucketsByDevice)[0];
    expect(device.device_ids).toEqual(expect.arrayContaining(['uuid-a', 'uuid-b']));
    expect(device.device_ids).toHaveLength(2);
  });
});

describe('device activity timestamps', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useServerStore().$patch({
      info: { hostname: 'self', device_id: 'local-uuid', version: '0.14.0', testing: true },
    });
  });

  test('ignores schedule timestamps by type or prefix without hiding their buckets', () => {
    const store = useBucketsStore();
    const reported = new Date('2026-11-19T15:00:00Z');
    store.update_buckets([
      bucket({ id: 'window', last_updated: reported }),
      bucket({
        id: 'custom-calendar',
        type: 'aw-webui-schedule',
        last_updated: new Date('2026-11-20T22:00:00Z'),
      }),
      bucket({
        id: 'aw-webui-schedule_erb-m2_generation-00000000-0000-4000-8000-000000000001-synced-from-peer',
        last_updated: new Date('2026-11-21T22:00:00Z'),
      }),
    ]);
    const device = store.bucketsByDevice['erb-m2'];
    expect(device.last_updated).toEqual(reported);
    expect(device.buckets).toHaveLength(3);
  });

  test('a schedule-only device has no reported activity timestamp', () => {
    const store = useBucketsStore();
    store.update_buckets([bucket({ id: 'aw-webui-schedule_erb-m2', type: 'aw-webui-schedule' })]);
    expect(store.bucketsByDevice['erb-m2'].last_updated).toBeUndefined();
    expect(store.bucketsByDevice['erb-m2'].buckets).toHaveLength(1);
  });

  test('a schedule-only device sorts after devices with reporting activity', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({
        id: 'aw-webui-schedule_scheduled',
        hostname: 'scheduled',
        type: 'aw-webui-schedule',
        last_updated: new Date('2030-01-01T00:00:00Z'),
      }),
      bucket({ id: 'window', hostname: 'active', last_updated: new Date('2026-11-19T15:00:00Z') }),
    ]);
    expect(Object.keys(store.bucketsByDevice)).toEqual(['active', 'scheduled']);
  });

  test('future appointments do not promote an inactive device in device or host sorting', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({ id: 'window-old', hostname: 'old', last_updated: new Date('2026-11-18T15:00:00Z') }),
      bucket({
        id: 'aw-webui-schedule_old',
        hostname: 'old',
        type: 'aw-webui-schedule',
        last_updated: new Date('2030-01-01T00:00:00Z'),
      }),
      bucket({ id: 'window-new', hostname: 'new', last_updated: new Date('2026-11-19T15:00:00Z') }),
    ]);
    expect(Object.keys(store.bucketsByDevice)).toEqual(['new', 'old']);
    expect(store.hosts).toEqual(['new', 'old']);
  });
});

describe('desktopBucketIds', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test('returns the real ids of buckets synced from another device', () => {
    const store = useBucketsStore();
    store.update_buckets([
      bucket({ id: 'aw-watcher-window_erb-m2' }),
      bucket({ id: 'aw-watcher-afk_erb-m2', type: 'afkstatus' }),
      bucket({
        id: 'aw-watcher-window_home-desktop-synced-from-home-desktop',
        hostname: 'home-desktop',
      }),
      bucket({
        id: 'aw-watcher-afk_home-desktop-synced-from-home-desktop',
        hostname: 'home-desktop',
        type: 'afkstatus',
      }),
    ]);

    expect(store.desktopBucketIds('home-desktop')).toEqual({
      bid_window: 'aw-watcher-window_home-desktop-synced-from-home-desktop',
      bid_afk: 'aw-watcher-afk_home-desktop-synced-from-home-desktop',
    });
    expect(store.desktopBucketIds('erb-m2')).toEqual({
      bid_window: 'aw-watcher-window_erb-m2',
      bid_afk: 'aw-watcher-afk_erb-m2',
    });
  });

  test('falls back to the conventional ids when no bucket is loaded', () => {
    const store = useBucketsStore();
    expect(store.desktopBucketIds('laptop')).toEqual({
      bid_window: 'aw-watcher-window_laptop',
      bid_afk: 'aw-watcher-afk_laptop',
    });
  });
});
