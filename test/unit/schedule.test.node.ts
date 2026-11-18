// Regression tests for the schedule feature's pure helpers — each case is a
// scenario surfaced in code review:
//  - content-key dedup used to hide genuinely different entries
//  - sanitized hostnames used to collide and overwrite query variables

import { dedupeScheduleEntries, queryVarNames, ScheduleEntry } from '~/util/schedule';

function entry(over: Partial<ScheduleEntry['data']> & { uid?: string }): ScheduleEntry {
  return {
    timestamp: '2026-11-18T06:00:00Z',
    duration: 3600,
    data: { title: '组会', ...over },
  } as ScheduleEntry;
}

describe('dedupeScheduleEntries', () => {
  test('merges synced copies of the same uid across buckets', () => {
    const a = { ...entry({ uid: 'u1' }), _bucket_id: 'b_origin' } as ScheduleEntry;
    const b = { ...entry({ uid: 'u1' }), _bucket_id: 'b_synced' } as ScheduleEntry;
    const out = dedupeScheduleEntries([a, b]);
    expect(out).toHaveLength(1);
    expect((out[0] as any)._bucket_id).toBe('b_origin'); // first seen wins
  });

  test('keeps distinct entries sharing time, duration and title but not uid', () => {
    // Review scenario: two same-named meetings in different rooms.
    const a = { ...entry({ uid: 'u1', notes: '会议室A' }) } as ScheduleEntry;
    const b = { ...entry({ uid: 'u2', notes: '会议室B' }) } as ScheduleEntry;
    expect(dedupeScheduleEntries([a, b])).toHaveLength(2);
  });

  test('entries without a uid are never hidden by a content match', () => {
    // Legacy entries (created before uids existed): two identical-looking
    // entries stay visible rather than being silently merged.
    const a = entry({});
    const b = entry({});
    expect(dedupeScheduleEntries([a, b])).toHaveLength(2);
  });
});

describe('queryVarNames', () => {
  test('sanitization collisions get unique suffixes via the index', () => {
    // Review scenario: "work-laptop" and "worklaptop" both sanitize to
    // "worklaptop"; the un-suffixed variables overwrote each other.
    const vars = queryVarNames(['work-laptop', 'worklaptop']);
    const names = [...vars.values()];
    expect(new Set(names).size).toBe(names.length);
    expect(vars.get('work-laptop')).not.toBe(vars.get('worklaptop'));
  });

  test('suffixes stay valid query identifiers for messy hostnames', () => {
    const vars = queryVarNames(['QBZdeMac-mini.local', 'qbzdemac-mini_local']);
    for (const v of vars.values()) {
      expect(v).toMatch(/^h\d+_[A-Za-z0-9_]+$/);
    }
    expect(new Set(vars.values()).size).toBe(2);
  });
});
