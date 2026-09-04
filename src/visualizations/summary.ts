'use strict';

import * as d3 from 'd3';
import Color from 'color';
import _ from 'lodash';

import { useCategoryStore } from '~/stores/categories';
import { getCategoryColorFromString } from '~/util/color';
import { seconds_to_duration } from '~/util/time';
import { IEvent } from '~/util/interfaces';

// Colors that adapt to the dark theme (see static/dark.css for the overrides).
// SVG presentation attributes can't use CSS variables, so these are set via
// inline style() where var() works.
const textColor = 'var(--aw-vis-text, #3C4257)';
const subTextColor = 'var(--aw-vis-subtext, #6B7280)';
const trackColor = 'var(--aw-vis-track, #EDF1F6)';

function create(container: HTMLElement) {
  // Clear element
  container.innerHTML = '';

  // Create svg canvas
  const svg = d3.select(container).append('svg');
  svg.attr('width', '100%').attr('height', '100px').attr('class', 'appsummary');
}

function set_status(container: HTMLElement, msg: string) {
  // Select svg canvas
  const svg_elem = container.querySelector('.appsummary');
  const svg = d3.select(svg_elem);
  svg_elem.innerHTML = '';

  svg
    .append('text')
    .attr('x', '0px')
    .attr('y', '25px')
    .text(msg)
    .attr('font-family', 'sans-serif')
    .attr('font-size', '20px')
    .attr('fill', '#999');
}

interface Entry {
  name: string;
  hovertext: string;
  duration: number;
  color?: string;
  colorKey?: string | string[];
  link?: string;
  category?: string;
}

function update(container: HTMLElement, apps: Entry[]) {
  // No apps, sets status to "No data"
  if (apps.length <= 0) {
    set_status(container, 'No data');
    return container;
  }

  const svg_elem = container.querySelector('.appsummary');
  svg_elem.innerHTML = '';
  const svg = d3.select(svg_elem);

  // Remove apps without a duration from list
  apps = apps.filter(function (app) {
    return app.duration !== undefined;
  });
  if (apps.length <= 0) {
    set_status(container, 'No data');
    return container;
  }

  const total_duration = _.sumBy(apps, 'duration');
  const longest_duration = apps[0].duration;

  // Layout: each row is a label line (name left, duration + share right)
  // above a full-width track with a rounded gradient fill proportional to
  // the longest entry. The track makes relative magnitudes readable even
  // when all values are small.
  const labelSize = 13;
  const rowHeight = 44;
  const barHeight = 9;
  const rowGap = 9;

  const defs = svg.append('defs');

  let curr_y = 2;
  _.each(apps, function (app, i) {
    // Variables
    const pct_of_longest = app.duration / longest_duration;
    const pct_of_total = total_duration > 0 ? app.duration / total_duration : 0;

    let appcolor: string;
    if (Array.isArray(app.colorKey)) {
      const categoryStore = useCategoryStore();
      appcolor = categoryStore.get_category_color(app.colorKey);
    } else {
      appcolor = app.color || getCategoryColorFromString(app.colorKey || app.name);
    }

    // A vertical gradient from the base color to a slightly darker shade
    // gives the bars depth without changing the palette hues.
    const gradId = 'awsum-grad-' + i + '-' + Math.abs(hash_str(app.name));
    const grad = defs
      .append('linearGradient')
      .attr('id', gradId)
      .attr('x1', '0')
      .attr('y1', '0')
      .attr('x2', '0')
      .attr('y2', '1');
    grad
      .append('stop')
      .attr('offset', '0%')
      .attr('stop-color', Color(appcolor).lighten(0.12).hex());
    grad.append('stop').attr('offset', '100%').attr('stop-color', appcolor);

    // Add a parent <a> element if link is set
    const a = app.link ? svg.append('a').attr('href', app.link) : svg;

    // The group representing an entry in the barchart
    const eg = a.append('g');
    eg.attr('id', 'summary_' + i).style('cursor', app.link ? 'pointer' : 'default');

    eg.append('title').text(app.hovertext + '\n' + seconds_to_duration(app.duration));

    const displayName = truncate_middle(app.name || '', 72);

    // Name (left, first line)
    eg.append('text')
      .attr('x', 1)
      .attr('y', curr_y + labelSize)
      .text(displayName)
      .attr('font-family', 'inherit')
      .attr('font-size', labelSize + 'px')
      .attr('font-weight', 500)
      .style('fill', textColor)
      .style('dominant-baseline', 'auto');

    // Duration + share of total (right-aligned, first line)
    const meta = seconds_to_duration(app.duration) + ' · ' + (pct_of_total * 100).toFixed(0) + '%';
    const metaText = eg
      .append('text')
      .attr('x', '100%')
      .attr('dx', -1)
      .attr('y', curr_y + labelSize)
      .attr('text-anchor', 'end')
      .text(meta)
      .attr('font-family', 'inherit')
      .attr('font-size', labelSize - 1.5 + 'px')
      .style('fill', subTextColor)
      .style('dominant-baseline', 'auto');

    // Avoid name/meta overlap on narrow containers: if the name would run
    // into the meta text, truncate it with an ellipsis. Measured via
    // getComputedTextLength after insertion.
    try {
      const metaWidth = (metaText.node() as SVGTextElement).getComputedTextLength();
      const nameNode = eg.select('text').node() as SVGTextElement;
      const availWidth = (svg_elem as SVGSVGElement).clientWidth - metaWidth - 16;
      if (nameNode.getComputedTextLength() > availWidth && availWidth > 40) {
        let name = displayName;
        while (name.length > 4 && nameNode.getComputedTextLength() > availWidth) {
          name = name.slice(0, -2);
          nameNode.textContent = name + '…';
        }
      }
    } catch (e) {
      // getComputedTextLength can fail if the svg is display:none — the
      // full name is then shown untruncated, which is acceptable.
    }

    // Track (full width, gives the fill something to be measured against)
    eg.append('rect')
      .attr('x', 0)
      .attr('y', curr_y + labelSize + 6)
      .attr('width', '100%')
      .attr('height', barHeight)
      .attr('rx', barHeight / 2)
      .attr('ry', barHeight / 2)
      .style('fill', trackColor);

    // Fill bar with the per-app gradient, animated in on first render.
    const fillY = curr_y + labelSize + 6;
    const fill = eg
      .append('rect')
      .attr('x', 0)
      .attr('y', fillY)
      .attr('height', barHeight)
      .attr('rx', barHeight / 2)
      .attr('ry', barHeight / 2)
      .attr('fill', 'url(#' + gradId + ')')
      .style('opacity', 0.95);

    fill
      .attr('width', 0)
      .transition()
      .duration(500)
      .delay(i * 40)
      .ease(d3.easeCubicOut)
      .attr('width', Math.max(pct_of_longest * 100, 1.2) + '%')
      .style('opacity', 1);

    // Hover: lift the bar slightly and strengthen the color.
    eg.on('mouseover', function () {
      fill.style('opacity', 1).attr('filter', 'brightness(1.06)');
    }).on('mouseout', function () {
      fill.style('opacity', 0.95).attr('filter', null);
    });

    curr_y += rowHeight + rowGap;
  });
  curr_y -= rowGap;
  curr_y += 2;

  svg.attr('height', curr_y);

  return container;
}

function hash_str(s: string): number {
  let hash = 0;
  if (s.length === 0) return hash;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

function truncate_middle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2) - 1;
  return s.slice(0, half) + '…' + s.slice(s.length - half);
}

function updateSummedEvents(
  container: HTMLElement,
  summedEvents: IEvent[],
  titleKeyFunc: (event: IEvent) => string,
  hoverKeyFunc: (event: IEvent) => string,
  colorKeyFunc: (event: IEvent) => string,
  linkKeyFunc: (event: IEvent) => string = () => null
) {
  if (hoverKeyFunc == null) {
    hoverKeyFunc = titleKeyFunc;
  }
  const apps = _.map(summedEvents, e => {
    return {
      name: titleKeyFunc(e),
      hovertext: hoverKeyFunc(e),
      duration: e.duration,
      color: e.data['$color'],
      colorKey: colorKeyFunc(e),
      link: linkKeyFunc(e),
      category: e.data['$category'],
    } as Entry;
  });
  update(container, apps);
}

export default {
  create: create,
  update: update,
  updateSummedEvents: updateSummedEvents,
  set_status: set_status,
};
