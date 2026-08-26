/* heatmap.js — the wealth surface: buy-path wealth for every (B, S) pair.
 *
 * The line chart fixes S and varies B. This varies both, so you can see the
 * whole surface at once and spot where buying is worth it rather than reading it
 * off one slice.
 *
 *   B (across)  the purchase delay
 *   S (up)      the sale month
 *
 * Cells where S < B are invalid — you cannot sell before you buy — so the valid
 * region is the triangle above the diagonal.
 *
 * Drawn by hand on a 2d canvas rather than with Chart.js, which has no matrix
 * chart type built in. That means this file owns its own layout, axes, colour
 * scale, colour bar and hover readout, and has to redraw itself on resize.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.heatmap = (function () {
  'use strict';

  const model = window.RentVsBuy.model;
  const { fmtCurrency, sampleMonths, stepForRange } = window.RentVsBuy.util;

  /* One simulation per cell, so the grid is capped rather than sampled at one
     point per month. At 100 per axis that is up to ~10,000 simulations, which
     stays comfortably interactive. */
  const MAX_CELLS_PER_AXIS = 100;

  // Room for the axis labels and titles, and for the colour bar on the right.
  const MARGIN = { left: 68, top: 12, right: 96, bottom: 46 };

  /* Everything the hover handler needs to answer "which cell is under the
     pointer": the axes, the values, and the last layout used to draw them. */
  const state = {
    canvas: null,
    noteEl: null,
    tooltip: null,
    purchaseMonths: [],
    saleMonths: [],
    matrix: [],
    layout: null,
  };

  // ------------------------------------------------------------ colour scale

  /**
   * Diverging scale anchored at zero: losses run red to amber, gains run amber
   * to green. Anchoring at zero rather than at the data range means the sign of
   * a cell is readable without consulting the colour bar.
   */
  function wealthToColor(value, minValue, maxValue) {
    if (value === null || !Number.isFinite(value)) return '#e5e7eb';  // invalid cell
    if (value < 0) {
      const span = Math.max(1e-8, -Math.min(0, minValue));
      const t = Math.min(1, Math.max(0, (value + span) / span));      // 0 at the worst loss
      return `hsl(${12 + 36 * t}, 82%, ${46 + 16 * t}%)`;
    }
    const span = Math.max(1e-8, Math.max(0, maxValue));
    const t = Math.min(1, Math.max(0, value / span));                 // 1 at the best gain
    return `hsl(${60 + 80 * t}, ${68 - 18 * t}%, ${62 - 24 * t}%)`;
  }

  // ------------------------------------------------------------ the simulation

  /** Run the model once per valid cell and note the range of the results. */
  function computeGrid(inputs) {
    /* Both axes run from today to the sale month: a purchase cannot follow the
       sale, and S is the horizon being studied. The step follows from the cell
       cap, so the grid cost is bounded however long the horizon is. */
    const maxMonth = inputs.saleMonth;
    const step = stepForRange(maxMonth, MAX_CELLS_PER_AXIS);

    const purchaseMonths = sampleMonths(maxMonth, step);
    const saleMonths = sampleMonths(maxMonth, step);
    const matrix = saleMonths.map(() => new Array(purchaseMonths.length).fill(null));

    let minValue = Infinity;
    let maxValue = -Infinity;

    for (let yi = 0; yi < saleMonths.length; yi++) {
      for (let xi = 0; xi < purchaseMonths.length; xi++) {
        if (saleMonths[yi] < purchaseMonths[xi]) continue;  // sale before purchase; leave it null
        const value = model.simulateBuyPath(inputs, purchaseMonths[xi], saleMonths[yi]).finalWealth;
        if (!Number.isFinite(value)) continue;
        matrix[yi][xi] = value;
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
      }
    }

    return {
      purchaseMonths,
      saleMonths,
      matrix,
      step,
      minValue: minValue === Infinity ? 0 : minValue,
      maxValue: maxValue === -Infinity ? 0 : maxValue,
    };
  }

  // ------------------------------------------------------------------ drawing

  /** Size the canvas for the display's pixel ratio and return the plot geometry. */
  function prepareCanvas(ctx, grid) {
    const canvas = state.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 400;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const layout = {
      width,
      height,
      left: MARGIN.left,
      top: MARGIN.top,
      right: Math.max(MARGIN.left + 20, width - MARGIN.right),
      bottom: Math.max(MARGIN.top + 48, height - MARGIN.bottom),
    };
    layout.innerW = Math.max(10, layout.right - layout.left);
    layout.innerH = Math.max(10, layout.bottom - layout.top);
    layout.cellW = layout.innerW / Math.max(1, grid.purchaseMonths.length);
    layout.cellH = layout.innerH / Math.max(1, grid.saleMonths.length);
    return layout;
  }

  /** Row 0 holds the smallest S, and is drawn at the bottom. */
  function rowToPixelY(layout, grid, rowIndex) {
    return layout.top + (grid.saleMonths.length - 1 - rowIndex) * layout.cellH;
  }

  function drawCells(ctx, layout, grid) {
    for (let yi = 0; yi < grid.saleMonths.length; yi++) {
      const y = rowToPixelY(layout, grid, yi);
      for (let xi = 0; xi < grid.purchaseMonths.length; xi++) {
        ctx.fillStyle = wealthToColor(grid.matrix[yi][xi], grid.minValue, grid.maxValue);
        // Overdraw by a pixel so fractional cell sizes leave no seams.
        ctx.fillRect(
          Math.floor(layout.left + xi * layout.cellW), Math.floor(y),
          Math.ceil(layout.cellW) + 1, Math.ceil(layout.cellH) + 1);
      }
    }
  }

  /** A dashed line showing which row of the surface the line chart is slicing. */
  function drawSelectedSaleMonth(ctx, layout, grid, saleMonth) {
    const maxSale = grid.saleMonths[grid.saleMonths.length - 1];
    if (saleMonth <= 0 || maxSale <= 0) return;

    const y = layout.top + layout.innerH * (1 - Math.min(1, saleMonth / maxSale));
    ctx.save();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.left + layout.innerW, y);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#1e293b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`selected S = ${saleMonth}`, layout.left + 6, y - 2);
  }

  function drawAxes(ctx, layout, grid) {
    ctx.fillStyle = '#111827';

    // B ticks along the bottom, thinned to at most a dozen labels.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '11px sans-serif';
    const xTickStep = Math.max(1, Math.ceil(grid.purchaseMonths.length / 12));
    for (let xi = 0; xi < grid.purchaseMonths.length; xi += xTickStep) {
      const x = layout.left + xi * layout.cellW + layout.cellW / 2;
      ctx.fillText(String(grid.purchaseMonths[xi]), Math.round(x), layout.bottom + 6);
    }
    ctx.font = '12px sans-serif';
    ctx.fillText('Purchase delay B (months)', layout.left + layout.innerW / 2, layout.bottom + 24);

    // S ticks down the left.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '11px sans-serif';
    const yTickStep = Math.max(1, Math.ceil(grid.saleMonths.length / 12));
    for (let yi = 0; yi < grid.saleMonths.length; yi += yTickStep) {
      const y = rowToPixelY(layout, grid, yi) + layout.cellH / 2;
      ctx.fillText(String(grid.saleMonths[yi]), layout.left - 8, Math.round(y));
    }

    // Rotated S axis title.
    ctx.save();
    ctx.translate(14, layout.top + layout.innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif';
    ctx.fillText('Sale month S (months)', 0, 0);
    ctx.restore();
  }

  /** Vertical colour bar keyed to the same scale as the cells. */
  function drawColorBar(ctx, layout, grid) {
    const barX = Math.min(layout.width - 74, layout.right + 18);
    const barW = 12;
    const barTop = layout.top;
    const barH = layout.innerH;
    const segments = 60;

    for (let i = 0; i < segments; i++) {
      // i = 0 is the minimum at the bottom, i = segments - 1 the maximum on top.
      const t = i / (segments - 1);
      const value = grid.minValue + t * (grid.maxValue - grid.minValue);
      const segH = barH / segments;
      ctx.fillStyle = wealthToColor(value, grid.minValue, grid.maxValue);
      ctx.fillRect(barX, barTop + barH - (i + 1) * segH, barW, segH + 1);
    }
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barTop, barW, barH);

    ctx.fillStyle = '#111827';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtCurrency(grid.maxValue), barX + barW + 4, barTop + 5);
    ctx.fillText(fmtCurrency(grid.minValue), barX + barW + 4, barTop + barH - 5);

    // Mark break-even, but only when the range actually crosses it.
    if (grid.minValue < 0 && grid.maxValue > 0) {
      const zeroY = barTop + barH * (grid.maxValue / (grid.maxValue - grid.minValue));
      ctx.strokeStyle = '#111827';
      ctx.beginPath();
      ctx.moveTo(barX, zeroY);
      ctx.lineTo(barX + barW, zeroY);
      ctx.stroke();
      ctx.fillText('$0', barX + barW + 4, zeroY);
    }
  }

  function draw(inputs, grid) {
    const ctx = state.canvas.getContext('2d');
    const layout = prepareCanvas(ctx, grid);
    state.layout = layout;

    drawCells(ctx, layout, grid);
    drawSelectedSaleMonth(ctx, layout, grid, inputs.saleMonth);

    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(layout.left, layout.top, layout.innerW, layout.innerH);

    drawAxes(ctx, layout, grid);
    drawColorBar(ctx, layout, grid);
  }

  // ------------------------------------------------------------- hover readout

  /** Which cell is under the pointer, or null if it is outside the plot. */
  function cellAt(pointerX, pointerY) {
    const layout = state.layout;
    if (!layout) return null;

    const xi = Math.floor((pointerX - layout.left) / layout.cellW);
    const yi = state.saleMonths.length - 1 - Math.floor((pointerY - layout.top) / layout.cellH);

    const inside = xi >= 0 && xi < state.purchaseMonths.length && yi >= 0 && yi < state.saleMonths.length
      && pointerX >= layout.left && pointerX <= layout.left + layout.innerW
      && pointerY >= layout.top && pointerY <= layout.top + layout.innerH;

    return inside ? { xi, yi, value: state.matrix[yi][xi] } : null;
  }

  /* The tooltip is a div rather than canvas text so it can never be clipped by
     the plot area. It is appended to the canvas's positioned parent. */
  function attachTooltip() {
    const tooltip = document.createElement('div');
    tooltip.className = 'heatmap-tooltip';
    tooltip.style.display = 'none';
    state.canvas.parentElement.appendChild(tooltip);
    state.tooltip = tooltip;

    state.canvas.addEventListener('mousemove', event => {
      const rect = state.canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const cell = cellAt(pointerX, pointerY);

      if (!cell) {
        tooltip.style.display = 'none';
        return;
      }

      tooltip.innerHTML = `B = ${state.purchaseMonths[cell.xi]} mo &middot; S = ${state.saleMonths[cell.yi]} mo<br>`
        + (cell.value === null ? 'invalid (S &lt; B)' : `<strong>${fmtCurrency(cell.value)}</strong>`);
      tooltip.style.display = 'block';
      // Sit above and to the right of the pointer, kept inside the canvas.
      tooltip.style.left = `${Math.min(pointerX + 14, rect.width - tooltip.offsetWidth - 4)}px`;
      tooltip.style.top = `${Math.max(4, pointerY - tooltip.offsetHeight - 10)}px`;
    });

    state.canvas.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  }

  // ------------------------------------------------------------ public surface

  function init(canvasId, noteId) {
    state.canvas = document.getElementById(canvasId);
    state.noteEl = document.getElementById(noteId);
    if (state.canvas && !state.tooltip) attachTooltip();
  }

  function render(inputs) {
    if (!state.canvas) return;

    const grid = computeGrid(inputs);
    state.purchaseMonths = grid.purchaseMonths;
    state.saleMonths = grid.saleMonths;
    state.matrix = grid.matrix;
    draw(inputs, grid);

    // Say so when the cell cap coarsened the grid, rather than quietly showing
    // fewer samples than the user asked for.
    if (state.noteEl) {
      state.noteEl.textContent = grid.step > 1
        ? `Sampled every ${grid.step} months, to hold the grid at ${MAX_CELLS_PER_AXIS} `
          + 'cells per axis.'
        : '';
    }
  }

  return { init, render };
})();
