/* app.js — wiring.
 *
 * The whole tool is one loop:
 *
 *     any input changes  ->  read the form  ->  run the model  ->  redraw
 *
 * Plus a shorter loop: ticking a series on or off only needs the chart redrawn,
 * not the model re-run, so the last run is kept and reused.
 *
 * This file is those two loops and nothing else. It owns no formulas; the maths
 * lives in model.js, the form in inputs.js, the catalogue of plottable lines in
 * series.js, and the drawing in line-chart.js and heatmap.js.
 */

(function () {
  'use strict';

  const { model, inputs, series, seriesControls, lineChart, heatmap, util } = window.RentVsBuy;
  const { fmtCurrency, sampleMonths } = util;

  /* Recalculating sweeps the model over the whole heatmap grid, so typing is
     debounced rather than recomputed on every keystroke. */
  const RENDER_DEBOUNCE_MS = 120;

  /* The last completed model run, so the chart can be redrawn when the visible
     series change without touching the model or the heatmap. */
  let lastRun = null;

  /* The wealth-surface heatmap and the detailed results table are still being
     worked on, so they stay out of the page unless the URL carries ?dev (or
     #dev). Leaving the heatmap out also skips thousands of simulations per
     redraw, which keeps typing in the inputs responsive. */
  const devFlags = location.search + location.hash;
  const devPanels = ['?dev', '&dev', '#dev'].some(flag => devFlags.includes(flag));

  function el(id) {
    return document.getElementById(id);
  }

  // ------------------------------------------------------------- the main loop

  /**
   * Run the model once per purchase month B, plus once for the rent path.
   * Returns the raw results; turning them into chart series happens separately
   * so that re-ticking a box does not re-run any of this.
   */
  function runScenarios(config) {
    /* Every month from today to the sale, with nothing thinned out. The chart's
       most informative features are one month wide - the insurance premium
       falling away as the down payment crosses a band, or a fixed-deposit term
       matching the wait exactly - and sampling every other month hides them, or
       worse, shifts the apparent dip to a neighbouring month. The cost is one
       model run per month, which is cheap enough to pay in full. */
    const purchaseMonths = sampleMonths(config.saleMonth, 1);

    return {
      config,
      labels: purchaseMonths,
      // The rent path's outcome at month S does not depend on B: computed once.
      rentResult: model.simulateRentPath(config, config.saleMonth),
      // The same renter's position read at each month B along the way.
      rentAtB: purchaseMonths.map(
        month => model.simulateRentPathAt(config, month, config.saleMonth)),
      buyScenarios: purchaseMonths.map(
        month => model.simulateBuyPath(config, month, config.saleMonth)),
    };
  }

  /* Where each series' `from` reads its number for the point at index i. */
  const SOURCES = {
    // Constant across B, so it repeats and plots as a flat reference line.
    rent: (run) => run.rentResult,
    rentAtB: (run, i) => run.rentAtB[i],
    buy: (run, i) => run.buyScenarios[i],
  };

  /** Pull one array per visible series out of a completed run. */
  function buildChartData(run, visibleKeys) {
    const data = {};
    series.all().forEach(spec => {
      if (!visibleKeys.has(spec.key)) return;
      const source = SOURCES[spec.from];
      data[spec.key] = run.labels.map((_, i) => spec.pick(source(run, i)));
    });
    return data;
  }

  // -------------------------------------------------------------------- verdict

  /** "in 14 months", "in 1 month", or "now" for a purchase today. */
  function whenPhrase(month) {
    if (month === 0) return 'now';
    return `in ${month} month${month === 1 ? '' : 's'}`;
  }

  /**
   * The headline answer, above everything else in the Analysis section: which
   * path wins, and the best month to buy if buying does. The arithmetic is
   * model.bestPurchase(); this only phrases it.
   */
  function renderVerdict(run) {
    const box = el('verdict');
    const headline = el('verdict-headline');
    const detail = el('verdict-detail');
    if (!box || !headline || !detail) return;

    const verdict = model.bestPurchase(run.rentResult, run.buyScenarios);
    const saleMonth = run.config.saleMonth;

    if (verdict.bestMonth === null) {
      box.className = 'verdict verdict-rent';
      headline.textContent = 'Nothing to compare yet';
      detail.textContent = '';
      return;
    }

    if (verdict.buyingWins) {
      box.className = 'verdict verdict-buy';
      headline.textContent = `Buying ${whenPhrase(verdict.bestMonth)} is the best strategy!`;
      const parts = [
        `${fmtCurrency(verdict.margin)} better off by month ${saleMonth} than never buying.`,
      ];
      if (verdict.lastWinningMonth > verdict.bestMonth) {
        parts.push(`Buying still beats renting anywhere up to month ${verdict.lastWinningMonth}.`);
      }
      detail.textContent = parts.join(' ');
      return;
    }

    box.className = 'verdict verdict-rent';
    headline.textContent = 'Renting beats buying at every month!';
    /* Buying at month S means buying and selling on the same day, which is not a
       strategy anybody would follow, so it is not held up as the closest case. */
    const behind = fmtCurrency(Math.abs(verdict.margin));
    detail.textContent = verdict.bestMonth >= saleMonth
      ? `No purchase month beats renting; even the closest ends ${behind} behind.`
      : `Buying ${whenPhrase(verdict.bestMonth)} comes closest, and still ends `
        + `${behind} behind by month ${saleMonth}.`;
  }

  // -------------------------------------------------------------- results table

  /** The same scenarios as the chart, spelled out. Hidden until toggled on. */
  function renderResultsTable(run) {
    const body = el('results-body');
    const panel = el('details-panel');
    if (!body) return;

    // Skip the work entirely while the panel is collapsed.
    if (!panel || panel.style.display === 'none') {
      body.innerHTML = '';
      return;
    }

    const rentWealth = run.rentResult.finalWealth;
    body.innerHTML = run.buyScenarios.map(row => `
      <tr class="border-t">
        <td class="px-4 py-2">${row.purchaseMonth}</td>
        <td class="px-4 py-2">${fmtCurrency(row.priceAtPurchase)}</td>
        <td class="px-4 py-2">${fmtCurrency(row.downPaymentUsed)}</td>
        <td class="px-4 py-2">${fmtCurrency(row.loanAmount)}</td>
        <td class="px-4 py-2">${row.mortgageInsuranceApplied
          ? `Yes at ${(row.mortgageInsuranceRate * 100).toFixed(2)}% (${fmtCurrency(row.mortgageInsurancePremium)})`
          : 'No'}</td>
        <td class="px-4 py-2 font-semibold text-blue-700">${fmtCurrency(row.finalWealth)}</td>
        <td class="px-4 py-2 font-semibold text-green-700">${fmtCurrency(rentWealth)}</td>
      </tr>
    `).join('');
  }

  // ------------------------------------------------------------------- redraw

  /**
   * Redraw only the wealth chart, from the last completed run.
   * `options.animate === false` applies the change with no transition.
   */
  function renderChart(options) {
    const canvas = el('wealthChart');
    if (!canvas || !lastRun) return;

    const data = buildChartData(lastRun, seriesControls.visibleKeys());
    try {
      lineChart.render(canvas, lastRun.labels, data, options);
    } catch (error) {
      // A chart failure should leave a visible explanation, not a blank box.
      console.error('Chart error', error);
      if (canvas.parentElement) {
        canvas.parentElement.innerHTML =
          `<div style="color:#b91c1c;padding:1rem">Chart error: ${error?.message ?? String(error)}</div>`;
      }
    }
  }

  function recalculateAndRender() {
    inputs.syncEnabledState();

    const config = inputs.readInputs();

    /* With no fixed deposit in the strategy, the FD lines would be flat zero, so
       their tick boxes are disabled rather than silently plotting nothing. */
    seriesControls.setAvailability(
      spec => spec.fdOnly && config.waitingStrategy !== 'fd-plus-etf');

    lastRun = runScenarios(config);

    renderVerdict(lastRun);
    renderChart();
    if (devPanels) heatmap.render(config);
    renderResultsTable(lastRun);
  }

  let renderTimer;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(recalculateAndRender, RENDER_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------- events

  function wireInputs() {
    // One listener on the form covers every field inside it.
    const form = el('calculator-form');
    if (form) {
      form.addEventListener('input', scheduleRender);
      form.addEventListener('change', scheduleRender);
      form.addEventListener('submit', event => {
        event.preventDefault();
        recalculateAndRender();
      });
    }

  }

  function wireDetailsToggle() {
    const button = el('toggle-details');
    const panel = el('details-panel');
    if (!button || !panel) return;

    button.addEventListener('click', () => {
      const willShow = panel.style.display === 'none';
      panel.style.display = willShow ? 'block' : 'none';
      button.textContent = willShow ? 'Hide details' : 'Show details';
      if (lastRun) renderResultsTable(lastRun);
    });
  }

  function wireResize() {
    /* Chart.js resizes itself. The heatmap is drawn by hand, so it needs an
       explicit redraw when the canvas changes size. */
    if (!devPanels) return;
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => heatmap.render(inputs.readInputs()), 150);
    });
  }

  function init() {
    /* Hovering is linked both ways: pointing at a line in the chart highlights
       its row in the legend, and pointing at a row emphasises its line. Both
       ends call the same handler, so either route reaches the same state. */
    const focusSeries = key => {
      seriesControls.setActive(key);
      lineChart.highlight(key);
    };
    lineChart.onSeriesHover(focusSeries);

    /* Ticking a box only changes what is drawn, so it skips the model entirely
       and applies with no animation: the line just appears or disappears. */
    seriesControls.init({
      container: 'series-controls',
      plotAll: 'plot-all',
      plotNone: 'plot-none',
      description: 'series-description',
      onChange: () => renderChart({ animate: false }),
      onHoverSeries: focusSeries,
    });
    if (devPanels) {
      // Reveal the in-progress panels and wire the heatmap only when asked for.
      ['wealth-surface', 'details-section'].forEach(id => {
        const panel = el(id);
        if (panel) panel.hidden = false;
      });
      heatmap.init('bsHeatmap', 'heatmap-note');
    }
    wireInputs();
    wireDetailsToggle();
    wireResize();
    recalculateAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
