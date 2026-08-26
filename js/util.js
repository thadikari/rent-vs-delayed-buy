/* util.js — small helpers shared by the view layer.
 *
 * Part of the Rent vs Delayed Buy calculator. Load order is set in index.html;
 * this file has no dependencies of its own.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.util = (function () {
  'use strict';

  const currencyFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  /** "$1,234" or "-$1,234"; an em dash for anything that is not a finite number. */
  function fmtCurrency(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const rounded = Math.round(value);
    return (rounded < 0 ? '-$' : '$') + currencyFormatter.format(Math.abs(rounded));
  }

  /**
   * Month values from 0 to maxMonth inclusive, `step` apart, always ending
   * exactly on maxMonth so a chart never stops short of its stated range.
   *
   *   sampleMonths(10, 3) -> [0, 3, 6, 9, 10]
   */
  function sampleMonths(maxMonth, step) {
    if (maxMonth <= 0) return [0];
    const months = [];
    for (let month = 0; month <= maxMonth; month += step) months.push(month);
    if (months[months.length - 1] !== maxMonth) months.push(maxMonth);
    return months;
  }

  /**
   * A sampling step that keeps a range at or below `maxPoints` samples, so a
   * long horizon costs no more to plot than a short one. Short horizons come
   * out at one point per month; long ones are thinned just enough.
   *
   *   stepForRange(84, 100) -> 1      stepForRange(300, 100) -> 4
   */
  function stepForRange(maxMonth, maxPoints) {
    if (maxMonth <= 0 || maxPoints <= 0) return 1;
    return Math.max(1, Math.ceil((maxMonth + 1) / maxPoints));
  }

  return { fmtCurrency, sampleMonths, stepForRange };
})();
