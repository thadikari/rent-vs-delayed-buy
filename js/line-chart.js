/* line-chart.js — the main chart: the selected series against the purchase delay B.
 *
 * The x-axis is a month counted from today, up to the sale month S. The
 * rent-path lines are simply read at that month; the buy-path lines are the
 * scenario where the purchase happens at that month, so there B = x.
 *
 * Every series is a dollar amount and they all share a
 * single scale on the right, so any combination can be read against the same
 * ruler.
 *
 * Which lines appear is decided by the check-box tree in series-controls.js, and
 * what each line is called and coloured comes from series.js. The built-in
 * Chart.js legend is switched off because that tree serves as the legend.
 *
 * Hovering is linked to that tree in both directions: the chart reports which
 * line is under the pointer (onSeriesHover), and highlight() emphasises a line
 * when its row in the tree is hovered.
 *
 * Pure presentation: it is handed a set of series keys and their data, and knows
 * nothing about how the numbers were produced.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.lineChart = (function () {
  'use strict';

  const fmtCurrency = window.RentVsBuy.util.fmtCurrency;
  const catalogue = window.RentVsBuy.series;

  /* How much a line is emphasised when focused, and how far the rest fade back. */
  const FOCUS_EXTRA_WIDTH = 2;
  const UNFOCUSED_ALPHA = 0.18;

  let chart;
  let focusedKey = null;
  let notifyHover = () => {};

  /** 'rgb(r,g,b)' -> 'rgba(r,g,b,alpha)'. */
  function fade(color, alpha) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }

  /* One dataset per series present in `data`, in catalogue order so the drawing
     order stays stable as lines are ticked on and off. When one series is
     focused it thickens and the others fade, so it stands out among twenty. */
  function buildDatasets(data) {
    return catalogue.all()
      .filter(spec => Array.isArray(data[spec.key]))
      .map(spec => {
        const width = spec.width || 2;
        const isFocused = focusedKey === spec.key;
        const dimmed = focusedKey !== null && !isFocused;
        return {
          // Carried so a hover can be traced back from a dataset to its series.
          seriesKey: spec.key,
          label: spec.label,
          data: data[spec.key],
          borderColor: dimmed ? fade(spec.color, UNFOCUSED_ALPHA) : spec.color,
          borderDash: spec.dash || [],
          borderWidth: isFocused ? width + FOCUS_EXTRA_WIDTH : width,
          fill: false,
          /* Straight segments between months, not a spline. A one-month step -
             an insurance band being crossed, say - has to read as a step; bezier
             smoothing rounds those corners off and can overshoot around them,
             drawing a curve the model never produced. */
          tension: 0,
          // No dots: one point per month would only add noise. The wider hit
          // radius keeps the shared tooltip easy to trigger.
          pointRadius: 0,
          pointHitRadius: 8,
        };
      });
  }

  /* The series under the pointer. The configured interaction mode is 'index',
     which reports every line in the column, so the nearest single line has to be
     asked for separately. */
  function seriesUnderPointer(event) {
    const hits = chart.getElementsAtEventForMode(
      event, 'nearest', { intersect: false, axis: 'xy' }, false);
    if (!hits.length) return null;
    return chart.data.datasets[hits[0].datasetIndex]?.seriesKey ?? null;
  }

  /** Register the callback told which series (or null) is hovered. */
  function onSeriesHover(callback) {
    notifyHover = callback || (() => {});
  }

  /**
   * Emphasise one series, or pass null to clear. Applied with no animation, and
   * a no-op when nothing changed — this runs off mousemove.
   */
  function highlight(key) {
    if (key === focusedKey) return;
    focusedKey = key;
    if (!chart) return;

    catalogue.all().forEach(spec => {
      const dataset = chart.data.datasets.find(d => d.seriesKey === spec.key);
      if (!dataset) return;
      const width = spec.width || 2;
      const isFocused = focusedKey === spec.key;
      const dimmed = focusedKey !== null && !isFocused;
      dataset.borderColor = dimmed ? fade(spec.color, UNFOCUSED_ALPHA) : spec.color;
      dataset.borderWidth = isFocused ? width + FOCUS_EXTRA_WIDTH : width;
    });
    chart.update('none');
  }

  /**
   * Draw or redraw the chart.
   *
   * The live instance is reused wherever possible and its data swapped in place,
   * so a redraw does not rebuild the chart from nothing. Pass `animate: false`
   * to apply the change with no transition at all — that is what ticking a
   * series on or off does, so lines appear and disappear instantly.
   */
  function render(canvas, labels, data, { animate = true } = {}) {
    if (chart && chart.canvas === canvas) {
      chart.data.labels = labels;
      chart.data.datasets = buildDatasets(data);
      // Chart.js mode 'none' updates without animating.
      chart.update(animate ? undefined : 'none');
      return;
    }

    // First draw, or the canvas was replaced underneath us.
    if (chart) chart.destroy();
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: buildDatasets(data) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            /* Not every chart here varies with a purchase: the rent-path lines
               never buy, so this axis is simply a month counted from today.
               For the buy-path lines, that month IS the purchase month B. */
            title: {
              display: true,
              text: ['Month (0 = today, up to the sale month S)',
                     'For buy-path charts, this month is the purchase month B'],
            },
          },
          // One shared dollar scale, drawn on the right.
          y: {
            position: 'right',
            ticks: { callback: value => fmtCurrency(value) },
          },
        },
        // 'index' so hovering anywhere on a column reports every line at that B.
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        onHover: event => notifyHover(seriesUnderPointer(event)),
        plugins: {
          // The check-box tree beside the chart is the legend.
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => `Month ${items[0]?.label ?? ''} (B = ${items[0]?.label ?? ''} for buy-path charts)`,
              label: context => `${context.dataset.label}: ${fmtCurrency(context.parsed.y)}`,
            },
          },
        },
      },
    });

    // onHover does not reliably fire on the way out, so clear it explicitly.
    canvas.addEventListener('mouseleave', () => notifyHover(null));
  }

  return { render, highlight, onSeriesHover };
})();
