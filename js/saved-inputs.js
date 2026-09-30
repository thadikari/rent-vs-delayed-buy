/* saved-inputs.js — save, reload and delete input sets, on this device only.
 *
 * Storage is `localStorage`, deliberately, and not cookies: a cookie is attached
 * to every request the browser makes to the host, so on a hosted copy of this
 * page a saved scenario would travel to the web server on each page load. Nothing
 * in localStorage ever leaves the browser, which is the only behaviour consistent
 * with what the page claims.
 *
 * Three sets are kept. Saving a fourth drops the oldest by its saved timestamp.
 * What gets stored is the raw form values, keyed by element id, so restoring is a
 * plain assignment and a set saved today still loads after the model changes.
 *
 * The controls stay out of the page until there is a reason for them: either the
 * form differs from the values it shipped with, or something is already saved and
 * therefore needs a way back.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.savedInputs = (function () {
  'use strict';

  const inputs = window.RentVsBuy.inputs;

  /* Namespaced, because every project page on a github.io account shares one
     origin and therefore one localStorage. Versioned so a future change of shape
     can ignore old entries instead of choking on them. */
  const STORAGE_KEY = 'rentVsDelayedBuy.savedInputs.v1';
  const MAX_SETS = 3;

  /* The values the form shipped with, captured before anything can change them.
     The only use is deciding whether the form has been edited at all, which is
     what brings the controls onto the page. */
  let defaults = null;
  let container = null;
  let onChange = null;

  // ------------------------------------------------------------------ storage

  /* Reading or writing localStorage throws outright in some configurations —
     Safari's private mode, a browser set to block site data — so every access is
     guarded and a failure degrades to "no saved sets" rather than a broken page. */
  function read() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(set => set && typeof set === 'object' && set.values)
        .slice(0, MAX_SETS);
    } catch (error) {
      return [];
    }
  }

  function write(sets) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
      return true;
    } catch (error) {
      return false;
    }
  }

  // -------------------------------------------------------------- comparisons

  function sameValues(a, b) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(key => String(a[key]) === String(b[key]));
  }

  /** Has the form been changed from the values it loaded with? */
  function isEdited() {
    return !sameValues(inputs.snapshot(), defaults);
  }

  // ------------------------------------------------------------------ actions

  function save() {
    const values = inputs.snapshot();
    const sets = read();

    /* Saving the same numbers twice would spend a slot on a duplicate, so an
       identical set is treated as "saved again" and just moves to the front. */
    const existing = sets.find(set => sameValues(set.values, values));
    if (existing) {
      existing.savedAt = new Date().toISOString();
    } else {
      sets.push({ id: String(Date.now()), savedAt: new Date().toISOString(), values });
    }

    // Oldest first, so the ones that fall off the end are the oldest.
    sets.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
    while (sets.length > MAX_SETS) sets.shift();

    return write(sets);
  }

  function load(id) {
    const set = read().find(candidate => candidate.id === id);
    if (!set) return;
    inputs.restore(set.values);
    if (onChange) onChange();
  }

  function remove(id) {
    write(read().filter(set => set.id !== id));
    if (onChange) onChange();
  }

  // ----------------------------------------------------------------- the view

  function button(className, text, title, handler) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = text;
    if (title) element.title = title;
    element.addEventListener('click', handler);
    return element;
  }

  /** "27 Aug, 14:32" — short enough to sit on one line in a chip. */
  function shortStamp(iso) {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return 'saved set';
    return when.toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  /** The few figures that identify a set at a glance, for the chip's tooltip. */
  function summarise(set) {
    const values = set.values || {};
    const parts = [
      `Saved ${new Date(set.savedAt).toLocaleString()}`,
      `House ${values['home-price'] || '?'}`,
      `rent ${values['monthly-rent'] || '?'}`,
      `budget ${values['monthly-income'] || '?'}`,
      `sale month ${values['selected-s'] || '?'}`,
    ];
    return parts.join(' · ') + '. Click to load these inputs.';
  }

  function render() {
    if (!container || !defaults) return;
    const sets = read().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    const edited = isEdited();

    container.textContent = '';
    // Nothing to offer: no edits to save, and nothing saved to go back to.
    container.classList.toggle('is-visible', edited || sets.length > 0);
    if (!edited && sets.length === 0) return;

    if (edited) {
      const saveButton = button(
        'saved-input-button', 'Save these inputs',
        `Keep the current inputs on this device only. ${MAX_SETS} sets are kept; `
          + 'saving another replaces the oldest.',
        () => {
          if (save()) {
            render();
          } else {
            saveButton.textContent = 'Could not save locally';
            saveButton.title = 'This browser is blocking site data, so nothing was stored.';
          }
        });
      container.appendChild(saveButton);
    }

    sets.forEach(set => {
      const chip = document.createElement('span');
      chip.className = 'saved-input-chip';
      chip.appendChild(button('saved-input-load', shortStamp(set.savedAt),
        summarise(set), () => load(set.id)));
      chip.appendChild(button('saved-input-remove', '×',
        'Delete this saved set', () => remove(set.id)));
      container.appendChild(chip);
    });
  }

  // ------------------------------------------------------------------- set-up

  /**
   * `containerId` is where the controls are drawn; `onLoad` is called after a set
   * is loaded or deleted so the caller can re-run the model.
   */
  function init(options) {
    container = document.getElementById(options.container);
    onChange = options.onLoad;
    // Whatever the form holds right now is the baseline for "edited".
    defaults = inputs.snapshot();
    render();
  }

  return { init, refresh: render };
})();
