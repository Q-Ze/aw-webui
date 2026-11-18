// Component test for ScheduleDetail — the round-4 P1 escapee category:
// "clicking an entry must render its detail without errors". The detail was
// extracted into a props-driven component so it can be tested without any
// store, client, or FullCalendar dependency.

import { shallowMount, createLocalVue } from '@vue/test-utils';
import BootstrapVue from 'bootstrap-vue';

import ScheduleDetail from '~/views/ScheduleDetail.vue';

const localVue = createLocalVue();
localVue.use(BootstrapVue);

function makeEntry(over: any = {}) {
  return {
    id: 7,
    timestamp: '2026-11-18T06:00:00Z', // 14:00 local (UTC+8)
    duration: 5400,
    data: { title: '周会', ...over.data },
    _bucket_id: 'aw-webui-schedule_self',
  };
}

describe('ScheduleDetail', () => {
  it('renders title, time range and buttons without errors', () => {
    const wrapper = shallowMount(ScheduleDetail, {
      localVue,
      stubs: { icon: true },
      propsData: { entry: makeEntry(), isRemote: false },
    });
    expect(wrapper.text()).toContain('周会');
    expect(wrapper.text()).toContain('14:00–15:30');
    // edit and delete actions must exist and be clickable
    expect(wrapper.find('[data-testid="schedule-detail-edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="schedule-detail-delete"]').exists()).toBe(true);
  });

  it('shows the plan-vs-actual bar and top apps when actual is given', () => {
    const wrapper = shallowMount(ScheduleDetail, {
      localVue,
      stubs: { icon: true },
      propsData: {
        entry: makeEntry(),
        actual: {
          activeSeconds: 3600,
          scheduledSeconds: 5400,
          topApps: [{ app: 'Code', seconds: 1800 }],
        },
      },
    });
    expect(wrapper.text()).toContain('实际活跃 1小时 / 计划 1小时30分');
    expect(wrapper.text()).toContain('（67%）');
    expect(wrapper.find('.schedule-detail-apps').text()).toContain('Code');
    expect(wrapper.find('.schedule-detail-apps').text()).toContain('30分钟');
  });

  it('marks remote-origin entries with the sync warning', () => {
    const wrapper = shallowMount(ScheduleDetail, {
      localVue,
      stubs: { icon: true },
      propsData: { entry: makeEntry(), isRemote: true },
    });
    expect(wrapper.find('[data-testid="schedule-detail-remote-hint"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('不会同步回原设备');
  });

  it('says 全天 for all-day entries and hides nothing when actual is absent', () => {
    const wrapper = shallowMount(ScheduleDetail, {
      localVue,
      stubs: { icon: true },
      propsData: {
        entry: makeEntry({ data: { title: '出差', allDay: true } }),
      },
    });
    expect(wrapper.text()).toContain('全天');
    expect(wrapper.text()).not.toContain('实际活跃');
  });
});
