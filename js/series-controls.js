/* series-controls.js — the check-box tree that decides which lines are drawn.
 *
 * It doubles as the chart's legend, which is why each row carries a colour
 * swatch: the built-in Chart.js legend is switched off because it cannot group
 * entries into sections.
 *
 * Two levels:
 *   section box  ticking or unticking it applies to every line in the section,
 *                and it shows a dash when only some of them are ticked
 *   line box     one per plottable series
 *
 * Rows can also be *unavailable* — the fixed-deposit lines under the ETF-only
 * strategy, where the deposit holds nothing. Those are disabled and dimmed
 * rather than removed, so it is clear they exist and why they are off.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.seriesControls = (function () {
  'use strict';

  const catalogue = window.RentVsBuy.series;

  // key -> { input, row, spec }, and section id -> { input, specs }
  const lines = new Map();
  const sections = new Map();
  let notifyChange = () => {};
  let notifyHover = () => {};
  let activeKey = null;
  let descriptionEl = null;
  let descriptionHint = '';

  /** A short bar in the series colour, dashed when the line is dashed. */
  function swatch(spec, extraClass) {
    const el = document.createElement('span');
    el.className = extraClass ? `series-swatch ${extraClass}` : 'series-swatch';
    if (spec.dash) {
      el.style.background =
        `repeating-linear-gradient(to right, ${spec.color} 0 5px, transparent 5px 9px)`;
    } else {
      el.style.background = spec.color;
    }
    if (spec.width && spec.width > 2) el.style.height = '4px';
    return el;
  }

  function buildLineRow(spec) {
    const row = document.createElement('label');
    row.className = 'series-row';

    const input = document.createElement('input');
    input.type = 'checkbox';
    // Only the headline pair starts on; the rest are one tick away.
    input.checked = !!spec.defaultOn;
    input.className = 'checkbox-field';
    input.addEventListener('change', () => {
      refreshSectionBoxes();
      notifyChange();
    });

    const text = document.createElement('span');
    text.className = 'series-label';
    text.textContent = spec.label;

    /* Hovering a row emphasises its line in the chart; the chart reports back
       the other way through setActive(). */
    row.addEventListener('mouseenter', () => notifyHover(spec.key));
    row.addEventListener('mouseleave', () => notifyHover(null));

    row.append(input, swatch(spec), text);
    lines.set(spec.key, { input, row, spec });
    return row;
  }

  function buildSection(section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'series-section';

    const header = document.createElement('label');
    header.className = 'series-section-header';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'checkbox-field';
    input.addEventListener('change', () => {
      // Apply to every line in the section that is currently available.
      section.series.forEach(spec => {
        const line = lines.get(spec.key);
        if (line && !line.input.disabled) line.input.checked = input.checked;
      });
      refreshSectionBoxes();
      notifyChange();
    });

    const title = document.createElement('span');
    title.className = 'series-section-title';
    title.textContent = section.title;

    header.append(input, title);
    wrapper.appendChild(header);

    if (section.note) {
      const note = document.createElement('div');
      note.className = 'series-section-note';
      note.textContent = section.note;
      wrapper.appendChild(note);
    }

    section.series.forEach(spec => wrapper.appendChild(buildLineRow(spec)));
    sections.set(section.id, { input, specs: section.series });
    return wrapper;
  }

  /* A section box reflects its available children: ticked when all are on,
     clear when none are, indeterminate in between. */
  function refreshSectionBoxes() {
    sections.forEach(section => {
      const available = section.specs
        .map(spec => lines.get(spec.key))
        .filter(line => line && !line.input.disabled);

      if (available.length === 0) {
        section.input.checked = false;
        section.input.indeterminate = false;
        section.input.disabled = true;
        return;
      }
      const ticked = available.filter(line => line.input.checked).length;
      section.input.disabled = false;
      section.input.checked = ticked === available.length;
      section.input.indeterminate = ticked > 0 && ticked < available.length;
    });
  }

  /**
   * Tick or untick every line at once. Unavailable rows are left alone, so
   * "plot all" never switches on a fixed-deposit line that holds nothing.
   */
  function setAll(checked) {
    lines.forEach(line => {
      if (line.input.disabled) {
        /* Cannot tick it now, but record the intent so the row comes back in
           this state if it becomes available again. */
        if (line.rememberedChecked !== undefined) line.rememberedChecked = checked;
      } else {
        line.input.checked = checked;
      }
    });
    refreshSectionBoxes();
    notifyChange();
  }

  /**
   * Build the tree.
   *   options.container  id of the element to build into
   *   options.plotAll    id of the "plot all" button, optional
   *   options.plotNone   id of the "plot none" button, optional
   *   options.onChange   called whenever the visible set changes
   *   options.description id of the panel that explains the focused series
   */
  function init(options) {
    const container = document.getElementById(options.container);
    if (!container) return;
    notifyChange = options.onChange || notifyChange;
    notifyHover = options.onHoverSeries || notifyHover;
    descriptionEl = document.getElementById(options.description);
    // Whatever the markup starts with is the "nothing focused" state.
    if (descriptionEl) descriptionHint = descriptionEl.textContent.trim();

    container.innerHTML = '';
    catalogue.SECTIONS.forEach(section => container.appendChild(buildSection(section)));
    refreshSectionBoxes();

    const plotAll = document.getElementById(options.plotAll);
    const plotNone = document.getElementById(options.plotNone);
    if (plotAll) plotAll.addEventListener('click', () => setAll(true));
    if (plotNone) plotNone.addEventListener('click', () => setAll(false));
  }

  /**
   * Mark rows unavailable. `isUnavailable(spec)` is called for every series;
   * rows it returns true for are disabled, dimmed and excluded from the chart.
   *
   * A row going unavailable is also unticked, so a greyed box never appears
   * ticked while its line is absent from the chart. Its previous state is kept
   * and restored if the row becomes available again, so switching strategy back
   * and forth does not lose the selection.
   */
  function setAvailability(isUnavailable) {
    lines.forEach(line => {
      const off = !!isUnavailable(line.spec);
      const wasOff = line.input.disabled;

      if (off && !wasOff) {
        line.rememberedChecked = line.input.checked;
        line.input.checked = false;
      } else if (!off && wasOff && line.rememberedChecked !== undefined) {
        line.input.checked = line.rememberedChecked;
        line.rememberedChecked = undefined;
      }

      line.input.disabled = off;
      line.row.classList.toggle('series-row-disabled', off);
    });
    refreshSectionBoxes();
  }

  /* Built from DOM nodes rather than innerHTML, so no text ever needs escaping
     and the panel cannot become a hole in the page. */
  function showDescription(key) {
    if (!descriptionEl) return;
    descriptionEl.textContent = '';

    const line = key && lines.get(key);
    if (!line) {
      const hint = document.createElement('span');
      hint.className = 'series-description-hint';
      hint.textContent = descriptionHint;
      descriptionEl.appendChild(hint);
      return;
    }

    const label = document.createElement('strong');
    label.textContent = line.spec.label;

    const body = document.createElement('span');
    body.className = 'series-description-body';
    body.textContent = line.spec.description || '';

    // Same swatch as the tick-box row, so the colours tie the two together.
    descriptionEl.append(swatch(line.spec, 'series-description-swatch'), label, body);
  }

  /**
   * Mark one row as the hovered series, or null for none. Called when the
   * pointer moves over a line in the chart, so the legend shows which one and
   * the description panel explains it.
   */
  function setActive(key) {
    if (key === activeKey) return;
    activeKey = key;
    lines.forEach((line, lineKey) => {
      line.row.classList.toggle('series-row-active', lineKey === key);
    });
    showDescription(key);
  }

  /** The keys to draw: ticked and available. */
  function visibleKeys() {
    const keys = new Set();
    lines.forEach((line, key) => {
      if (line.input.checked && !line.input.disabled) keys.add(key);
    });
    return keys;
  }

  return { init, setAll, setActive, setAvailability, visibleKeys };
})();
