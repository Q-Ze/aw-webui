/**
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */
import { createLocalVue, mount } from '@vue/test-utils';
import BootstrapVue from 'bootstrap-vue';
import moment from 'moment';
import Schedule from '~/views/Schedule.vue';

const mockFetchSchedule = jest.fn();
const mockFetchActual = jest.fn();
const mockSave = jest.fn();
const mockDelete = jest.fn();
const mockLocalBucketId = jest.fn();

jest.mock('~/util/schedule', () => ({
  ...jest.requireActual('~/util/schedule'),
  fetchSchedule: (...args) => mockFetchSchedule(...args),
  fetchActualEvents: (...args) => mockFetchActual(...args),
  saveEntry: (...args) => mockSave(...args),
  deleteEntry: (...args) => mockDelete(...args),
  localScheduleBucketId: () => mockLocalBucketId(),
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 10));
const localVue = createLocalVue();
localVue.use(BootstrapVue);
const entry = {
  id: 7,
  timestamp: '2026-11-18T09:00:00+08:00',
  duration: 3600,
  data: { title: '讨论', uid: 'entry-uid' },
  _bucket_id: 'aw-webui-schedule_self',
};
let wrappers: any[];
let listeners: ((event: { matches: boolean }) => void)[];
let media: any;

beforeEach(() => {
  wrappers = [];
  listeners = [];
  media = {
    matches: false,
    addEventListener: jest.fn((_type, fn) => listeners.push(fn)),
    removeEventListener: jest.fn(),
  };
  window.matchMedia = jest.fn().mockReturnValue(media);
  mockFetchSchedule.mockReset().mockResolvedValue([entry]);
  mockFetchActual
    .mockReset()
    .mockResolvedValue([{ timestamp: entry.timestamp, duration: 1800, data: { app: 'Code' } }]);
  mockSave.mockReset().mockResolvedValue(undefined);
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockLocalBucketId.mockReset().mockResolvedValue(entry._bucket_id);
});
afterEach(() => {
  wrappers.forEach(wrapper => wrapper.destroy());
});

async function mountSchedule() {
  const wrapper: any = mount(Schedule, {
    localVue,
    attachTo: document.body,
    stubs: { icon: true, transition: false },
    data: () => ({ fcDate: moment('2026-11-18'), month: moment('2026-11-01') }),
  });
  wrappers.push(wrapper);
  await flush();
  return wrapper;
}

it('navigates the real week grid, title, and fetched range together', async () => {
  const wrapper = await mountSchedule();
  const api = wrapper.vm.$refs.fc.getApi();
  expect(api.view.type).toBe('timeGridWeek');
  expect(wrapper.findAll('.fc-col-header-cell')).toHaveLength(7);
  await wrapper.find('[data-testid="schedule-next"]').trigger('click');
  await flush();
  expect(moment(api.view.currentStart).format('YYYY-MM-DD')).toBe('2026-11-23');
  expect(wrapper.vm.periodLabel).toContain('23');
  const [start, end] = mockFetchSchedule.mock.calls.slice(-1)[0];
  expect(start.format('YYYY-MM-DD')).toBe('2026-11-23');
  expect(end.format('YYYY-MM-DD')).toBe('2026-11-30');
});

it('preserves a selected past date when returning from the month grid', async () => {
  const wrapper = await mountSchedule();
  wrapper.vm.setMode('month');
  await flush();
  wrapper.vm.jumpToWeek(moment('2026-10-14'));
  await flush();
  const api = wrapper.vm.$refs.fc.getApi();
  expect(moment(api.getDate()).format('YYYY-MM-DD')).toBe('2026-10-14');
  expect(moment(api.view.currentStart).format('YYYY-MM-DD')).toBe('2026-10-12');
});

it('switches on resize and removes the media listener on destruction', async () => {
  const wrapper = await mountSchedule();
  const api = wrapper.vm.$refs.fc.getApi();
  listeners[0]({ matches: true });
  await flush();
  expect(api.view.type).toBe('timeGridDay');
  expect(moment(api.getDate()).format('YYYY-MM-DD')).toBe('2026-11-18');
  await wrapper.findAll('.schedule-day').at(6).trigger('click');
  await flush();
  expect(moment(api.getDate()).format('YYYY-MM-DD')).toBe('2026-11-22');
  listeners[0]({ matches: false });
  await flush();
  expect(api.view.type).toBe('timeGridWeek');
  wrapper.destroy();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', listeners[0]);
  wrappers = [];
});

it('starts directly in day mode on a phone', async () => {
  media.matches = true;
  const wrapper = await mountSchedule();
  expect(wrapper.vm.$refs.fc.getApi().view.type).toBe('timeGridDay');
  expect(wrapper.findAll('.schedule-day')).toHaveLength(7);
});

it('clicks an actual calendar event and renders the drawer with usage and actions', async () => {
  const wrapper = await mountSchedule();
  const event = wrapper.find('.fc-timegrid-event');
  expect(event.exists()).toBe(true);
  await event.trigger('click');
  await flush();
  expect(wrapper.vm.drawerOpen).toBe(true);
  await flush();
  const detail = document.querySelector('.schedule-detail');
  expect(detail).not.toBeNull();
  expect(detail.textContent).toContain('讨论');
  expect(detail.textContent).toContain('实际活跃 30分钟');
  expect(detail.textContent).toContain('Code');
  (detail.querySelector('[data-testid="schedule-detail-edit"]') as HTMLElement).click();
  await flush();
  expect(wrapper.vm.editing._bucket_id).toBe(entry._bucket_id);
});

it('prefills an all-day click and saves through the modal ok event', async () => {
  const wrapper = await mountSchedule();
  wrapper.vm.onDateClick({ date: new Date('2026-11-17T00:00:00+08:00'), allDay: true });
  expect(wrapper.vm.form.allDay).toBe(true);
  wrapper.vm.form.title = '  出差  ';
  wrapper.vm.$refs.editModal.$emit('ok', { preventDefault: jest.fn() });
  await flush();
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockSave.mock.calls[0][0]).toMatchObject({
    duration: 0,
    data: { title: '出差', allDay: true },
  });
  expect(moment(mockSave.mock.calls[0][0].timestamp).format('YYYY-MM-DD HH:mm')).toBe(
    '2026-11-17 00:00'
  );
});

it('prevents re-entry, invalid times and whitespace titles; shows save errors', async () => {
  const wrapper = await mountSchedule();
  wrapper.vm.form.title = ' ';
  await wrapper.vm.submit();
  wrapper.vm.form.title = '新日程';
  wrapper.vm.form.start = '';
  await wrapper.vm.submit();
  expect(mockSave).not.toHaveBeenCalled();
  wrapper.vm.form.start = '09:00';
  let rejectSave: (err: Error) => void;
  mockSave.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      })
  );
  const first = wrapper.vm.submit();
  await wrapper.vm.submit();
  expect(mockSave).toHaveBeenCalledTimes(1);
  rejectSave(new Error('offline'));
  await first;
  expect(wrapper.vm.saveError).toContain('offline');
  expect(wrapper.vm.saving).toBe(false);
});

it('ignores older range results and shows an actual query failure as unavailable', async () => {
  const wrapper = await mountSchedule();
  let finishOld: (events: unknown[]) => void;
  mockFetchSchedule.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishOld = resolve;
      })
  );
  const old = wrapper.vm.refreshSchedule();
  wrapper.vm.gotoDay(moment('2026-11-25'));
  await flush();
  finishOld([{ ...entry, data: { title: 'stale' } }]);
  await old;
  expect(wrapper.vm.entries[0].data.title).toBe('讨论');
  mockFetchActual.mockRejectedValueOnce(new Error('offline'));
  await wrapper.vm.refreshActual();
  expect(wrapper.vm.actualError).toBe(true);
  expect(wrapper.vm.actualEvents).toEqual([]);
});

it('keeps overnight start date, identity and duration when edited from the next day', async () => {
  const wrapper = await mountSchedule();
  const overnight = { ...entry, timestamp: '2026-11-17T23:00:00+08:00', duration: 7200 };
  wrapper.vm.openEdit(overnight);
  await wrapper.vm.submit();
  expect(mockSave.mock.calls[0][0]).toMatchObject({
    id: 7,
    _bucket_id: entry._bucket_id,
    duration: 7200,
    data: { uid: entry.data.uid },
  });
  expect(moment(mockSave.mock.calls[0][0].timestamp).format('YYYY-MM-DD HH:mm')).toBe(
    '2026-11-17 23:00'
  );
});

it('keeps the browsed month when switching directly back to the week grid', async () => {
  const wrapper = await mountSchedule();
  wrapper.vm.setMode('month');
  await flush();
  wrapper.vm.shiftPeriod(1);
  await flush();
  wrapper.vm.setMode('week');
  await flush();
  expect(moment(wrapper.vm.$refs.fc.getApi().getDate()).format('YYYY-MM-DD')).toBe('2026-12-18');
});

it('queries the complete span of a cross-week entry for its detail statistics', async () => {
  const wrapper = await mountSchedule();
  const overnight = { ...entry, timestamp: '2026-11-15T23:00:00+08:00', duration: 7200 };
  mockFetchActual.mockResolvedValueOnce([
    { timestamp: overnight.timestamp, duration: 7200, data: { app: 'Code' } },
  ]);
  wrapper.vm.entries = [overnight];
  wrapper.vm.onEventClick({ event: { id: wrapper.vm.entryUid(overnight) } });
  await flush();
  const [start, end] = mockFetchActual.mock.calls.slice(-1)[0];
  expect(start.format('YYYY-MM-DD HH:mm')).toBe('2026-11-15 23:00');
  expect(end.format('YYYY-MM-DD HH:mm')).toBe('2026-11-16 01:00');
  expect(wrapper.vm.selectedActual.activeSeconds).toBe(7200);
  expect(wrapper.vm.selectedActual.scheduledSeconds).toBe(7200);
});

it('ignores detail results from an older selection and surfaces detail query failures', async () => {
  const wrapper = await mountSchedule();
  const overnight = { ...entry, timestamp: '2026-11-15T23:00:00+08:00', duration: 7200 };
  let rejectOld: (err: Error) => void;
  mockFetchActual.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      })
  );
  wrapper.vm.selectedEntry = overnight;
  await flush();
  expect(wrapper.vm.detailActualLoading).toBe(true);
  wrapper.vm.selectedEntry = entry;
  await flush();
  rejectOld(new Error('late failure'));
  await flush();
  expect(wrapper.vm.detailActualError).toBe(false);
  expect(wrapper.vm.selectedActual.activeSeconds).toBe(1800);
  mockFetchActual.mockRejectedValueOnce(new Error('offline'));
  wrapper.vm.selectedEntry = overnight;
  await flush();
  expect(wrapper.vm.detailActualError).toBe(true);
  expect(wrapper.vm.selectedActual).toBeUndefined();
});
