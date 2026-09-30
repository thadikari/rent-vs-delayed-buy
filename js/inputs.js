/* inputs.js — the form, in both directions.
 *
 * Reading:  readInputs() collects every field into one plain object, converting
 *           percentages to fractions and annual rates to monthly ones. That
 *           object is the only thing model.js ever sees, so this file is the
 *           single boundary between the DOM and the model.
 *
 * Writing:  syncEnabledState() greys out the controls that the current choice of
 *           options makes irrelevant.
 *
 * If you add an input, it needs a line here and a line in model.js — nowhere
 * else reads the form.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.inputs = (function () {
  'use strict';

  const model = window.RentVsBuy.model;

  // --------------------------------------------------------------- DOM readers

  function el(id) {
    return document.getElementById(id);
  }

  function readNumber(id, fallback = 0) {
    const input = el(id);
    if (!input) return fallback;
    const value = parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function readInteger(id, fallback = 0) {
    const input = el(id);
    if (!input) return fallback;
    const value = parseInt(input.value, 10);
    return Number.isFinite(value) ? value : fallback;
  }

  /** A field entered as a percentage, returned as a fraction (6.5 -> 0.065). */
  function readPercent(id, fallback = 0) {
    return readNumber(id, fallback) / 100;
  }

  /** The chosen value of a <select>, or `fallback` if the field is missing. */
  function readChoice(id, fallback) {
    return el(id)?.value || fallback;
  }

  // -------------------------------------------------------------- the snapshot

  /**
   * Read the whole form into the object the model expects.
   *
   * Field naming follows the model's rate conventions: `...MonthlyRate` for an
   * APR already divided by 12, `...Monthly` for an effective annual growth rate
   * already converted, and `...Rate` for a plain fraction of some amount.
   */
  function readInputs() {
    const homeAppreciationAnnual = readPercent('appreciation-rate');

    return {
      // ---- the home and its financing
      homePriceToday: readNumber('home-price'),
      homeAppreciationAnnual,                                        // grows the price to B and S
      homeAppreciationMonthly: model.effectiveMonthlyRate(homeAppreciationAnnual),
      mortgageMonthlyRate: readPercent('interest-rate') / 12,        // APR
      mortgageTermMonths: Math.max(1, readInteger('mortgage-term', 25) * 12),
      purchaseClosingCostRate: readPercent('purchase-closing-cost-percent'),
      mdInsuranceMode: readChoice('mortgage-insurance-option', 'capitalized'),
      mdInsuranceCustomRate: readPercent('md-custom-rate'),          // 0 means "use the bands"

      // ---- renting, and the income that funds everything
      monthlyIncome: readNumber('monthly-income'),
      monthlyRent: readNumber('monthly-rent'),
      rentGrowthMonthly: model.effectiveMonthlyRate(readPercent('rent-increase')),
      otherRentalMonthly: readNumber('rental-insurance-annual') / 12,
      otherRentalGrowthMonthly: model.effectiveMonthlyRate(readPercent('rental-insurance-increase')),

      // ---- how the waiting period is invested
      cashOnHand: readNumber('cash-on-hand'),
      // An APR, applied a twelfth at a time, every month.
      waitingMonthlyRate: readPercent('wait-apr') / 12,

      // ---- owning the home, and selling it
      propertyTaxRate: readPercent('property-tax'),                  // all three are shares
      maintenanceRate: readPercent('maintenance-percent'),           // of the home's value,
      homeInsuranceRate: readPercent('home-insurance-percent'),      // charged annually
      utilitiesMonthly: readNumber('utilities-monthly'),
      // ---- and the same for the savings held after the purchase
      ownershipMonthlyRate: readPercent('own-apr') / 12,
      sellingCostRate: readPercent('realtor-commission'),
      fixedSellingFees: readNumber('legal-fees'),

      /* ---- what the charts cover
         S is the only horizon control: it ends both paths and bounds the
         x-axis. How densely the charts sample that range is decided in code,
         not by the user. */
      saleMonth: Math.max(0, readInteger('selected-s', 84)),
    };
  }

  // ------------------------------------------------------------ enabled state

  /** Hide the insurance rate controls when no insurance applies. */
  function syncMortgageInsuranceState() {
    const enabled = readChoice('mortgage-insurance-option', 'capitalized') !== 'none';
    const container = el('md-custom-rate-container');
    const note = el('md-rate-bands-note');
    const customRate = el('md-custom-rate');

    /* With no premium to charge, neither the custom rate nor the table of bands
       it overrides means anything, so both leave the page rather than sitting
       there greyed out. The field stays disabled too, so nothing hidden is
       reachable by tabbing. */
    if (container) container.classList.toggle('hidden', !enabled);
    if (note) note.classList.toggle('hidden', !enabled);
    if (customRate) customRate.disabled = !enabled;
  }

  /**
   * Show the selected option's own description under a dropdown.
   *
   * A <select> cannot carry a second line per option, so each <option> holds its
   * description in a data attribute and the one that is chosen is echoed into
   * `<selectId>-note`. The text stays in index.html, next to the option it
   * describes, rather than being duplicated here.
   */
  function syncChoiceNote(selectId) {
    const select = el(selectId);
    const note = el(`${selectId}-note`);
    if (!select || !note) return;
    const chosen = select.options[select.selectedIndex];
    note.textContent = chosen?.dataset.description || '';
  }

  // ------------------------------------------------------- the form verbatim

  /**
   * Every field in the form as raw strings, keyed by element id.
   *
   * This is the whole form rather than the model's view of it, which is what
   * saving a scenario needs: put the same object back and the form is exactly as
   * it was, whatever the model later does with those numbers. Enumerated from the
   * DOM, so a field added to index.html is covered without a change here.
   */
  function snapshot() {
    const values = {};
    document.querySelectorAll('#calculator-form input[id], #calculator-form select[id]')
      .forEach(field => {
        values[field.id] = field.type === 'checkbox' ? field.checked : field.value;
      });
    return values;
  }

  /** Put a snapshot back. Ids that no longer exist are skipped. */
  function restore(values) {
    Object.keys(values || {}).forEach(id => {
      const field = el(id);
      if (!field) return;
      if (field.type === 'checkbox') field.checked = !!values[id];
      else field.value = values[id];
    });
  }

  /**
   * Show the chosen setting beside a collapsed section's title.
   *
   * The insurance controls sit in a <details> that starts shut, so without this
   * the page would hide a setting that changes the answer.
   */
  function syncCollapsedSummary(selectId, summaryId) {
    const select = el(selectId);
    const summary = el(summaryId);
    if (!select || !summary) return;
    const chosen = select.options[select.selectedIndex];
    // A leading space so a screen reader does not run the two together; the
    // flex gap handles the visual spacing.
    summary.textContent = chosen?.dataset.summary ? ` (${chosen.dataset.summary})` : '';
  }

  function syncEnabledState() {
    syncMortgageInsuranceState();
    syncChoiceNote('mortgage-insurance-option');
    syncCollapsedSummary('mortgage-insurance-option', 'md-summary');
  }

  return { readInputs, syncEnabledState, snapshot, restore };
})();
