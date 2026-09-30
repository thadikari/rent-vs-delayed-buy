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

  const { model, inputs, series, seriesControls, lineChart, heatmap, savedInputs, util }
    = window.RentVsBuy;
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
       most informative feature is one month wide - the insurance premium falling
       away as the down payment crosses a band - and sampling every other month
       hides it, or worse, shifts the apparent step to a neighbouring month. The cost is one
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

  /**
   * Pull one array per visible series out of a completed run.
   *
   * Buy-path lines are left blank at months where the purchase could not be
   * made - a down payment below the legal minimum is not a worse deal but no
   * deal - so the chart breaks there instead of drawing a number for something
   * that cannot happen.
   */
  function buildChartData(run, visibleKeys) {
    const data = {};
    series.all().forEach(spec => {
      if (!visibleKeys.has(spec.key)) return;
      const source = SOURCES[spec.from];
      data[spec.key] = run.labels.map((_, i) => {
        const scenario = source(run, i);
        if (spec.from === 'buy' && !scenario.purchasePossible) return null;
        return spec.pick(scenario);
      });
    });
    return data;
  }

  // -------------------------------------------------------------------- verdict

  /** "in 14 months", "in 1 month", or "now" for a purchase today. */
  function whenPhrase(month) {
    if (month === 0) return 'now';
    return `in ${month} month${month === 1 ? '' : 's'}`;
  }

  /** "month 14", or "today" for month zero. */
  function monthPhrase(month) {
    return month === 0 ? 'today' : `month ${month}`;
  }

  /**
   * The headline answer, above everything else in the Analysis section.
   *
   * It carries three kinds of news, in order of how much they matter: a
   * purchase that cannot legally happen at all, a comparison between two
   * outcomes that both lose money, and - the ordinary case - which path wins and
   * when. Anything the numbers cannot support is said plainly rather than
   * dressed up as an answer.
   */
  function renderVerdict(run) {
    const box = el('verdict');
    const headline = el('verdict-headline');
    const detail = el('verdict-detail');
    if (!box || !headline || !detail) return;

    const verdict = model.bestPurchase(run.rentResult, run.buyScenarios);
    const saleMonth = run.config.saleMonth;
    const rent = run.rentResult;
    const notes = [];

    /* The rent path is the benchmark. If the rent alone outruns the budget the
       whole comparison rests on borrowing, so that is said first. */
    if (rent.monthsOverBudget > 0) {
      notes.push(`Rent is more than your monthly budget from ${monthPhrase(rent.firstOverBudgetMonth)}`
        + `, so the rent path only balances by borrowing.`);
    }

    // ---- nothing could be bought at any month
    if (!verdict.anyPossible) {
      box.className = 'verdict verdict-warn';
      headline.textContent = 'No purchase is possible with these numbers';
      const short = verdict.smallestShortfall;
      detail.textContent = [
        `The down payment never reaches the legal minimum: at the closest month it is still `
        + `${fmtCurrency(short)} short.`,
        'Canada requires 5% of the first $500,000 and 10% of the rest, and 20% above $1.5M.',
      ].concat(notes).join(' ');
      return;
    }

    const gapNote = verdict.firstPossibleMonth > 0
      ? `Buying is only possible from month ${verdict.firstPossibleMonth}; before that the down `
        + `payment is below the legal minimum, which is why the line starts there.`
      : null;
    if (gapNote) notes.push(gapNote);
    if (verdict.monthsOverBudget > 0) {
      notes.push(`At that month the housing cost is over your budget for `
        + `${verdict.monthsOverBudget} of the months you own, which the model covers by borrowing.`);
    }

    // ---- both paths lose money, so the "winner" is only the smaller loss
    if (verdict.bothNegative) {
      box.className = 'verdict verdict-warn';
      headline.textContent = 'Both paths lose money here';
      detail.textContent = [
        `Buying ${whenPhrase(verdict.bestMonth)} ends at ${fmtCurrency(verdict.bestWealth)} and never `
        + `buying at ${fmtCurrency(verdict.rentWealth)}, so this is a choice between two losses, `
        + 'not a recommendation.',
      ].concat(notes).join(' ');
      return;
    }

    // ---- the ordinary answer
    if (verdict.buyingWins) {
      box.className = 'verdict verdict-buy';
      headline.textContent = `Buying ${whenPhrase(verdict.bestMonth)} is the best strategy!`;
      const parts = [
        `${fmtCurrency(verdict.margin)} better off by month ${saleMonth} than never buying.`,
      ];
      if (verdict.lastWinningMonth > verdict.bestMonth) {
        parts.push(`Buying still beats renting anywhere up to month ${verdict.lastWinningMonth}.`);
      }
      detail.textContent = parts.concat(notes).join(' ');
      return;
    }

    box.className = 'verdict verdict-rent';
    headline.textContent = 'Renting beats buying at every month!';
    const behind = fmtCurrency(Math.abs(verdict.margin));
    const closest = verdict.bestMonth >= saleMonth
      ? `No purchase month beats renting; even the closest ends ${behind} behind.`
      : `Buying ${whenPhrase(verdict.bestMonth)} comes closest, and still ends ${behind} behind `
        + `by month ${saleMonth}.`;
    detail.textContent = [closest].concat(notes).join(' ');
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

    lastRun = runScenarios(config);

    renderVerdict(lastRun);
    // Whether the save controls belong on screen depends on the current values.
    savedInputs.refresh();
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
    /* Before anything else touches the form, so the values it ships with become
       the baseline for "has this been edited". */
    savedInputs.init({
      container: 'saved-inputs',
      onLoad: recalculateAndRender,
    });
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
