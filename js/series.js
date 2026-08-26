/* series.js — the catalogue of every line the wealth chart can draw.
 *
 * One place defines what is plottable, what it is called, what colour it gets
 * and where its number comes from. Both the chart (line-chart.js) and the
 * check-box tree beside it (series-controls.js) read this file, so the two can
 * never drift apart.
 *
 * Each entry:
 *   key     unique id, used by the check boxes and as the dataset key
 *   label   what the tick box and the tooltip call it
 *   color   line colour, and the swatch shown next to its tick box
 *   from    where the number comes from, one of:
 *             'rent'    the rent path at month S  (constant, plots flat)
 *             'rentAtB' the rent path read at month B
 *             'buy'     the buy scenario for that B
 *   pick    pulls the number out of that result
 *   dash    draw dashed (used for a line that should sit on top of another)
 *   width   line width, for emphasising a headline answer
 *   fdOnly  only meaningful when a fixed deposit is in play; disabled otherwise
 *   defaultOn  ticked when the page loads; everything else starts unticked
 *
 * Colour is assigned by section — greens for the rent path, purples for house
 * value, ambers for the wait, roses for the purchase, blues for ownership — so a
 * line's family tells you which section it belongs to.
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.series = (function () {
  'use strict';

  const SECTIONS = [
    {
      /* The headline comparison, deliberately first and the only pair ticked at
         start-up. Both are measured at month S, which is what makes them
         comparable; the detailed sections below break each path down. */
      id: 'headline',
      title: 'Total wealth: rent path vs delayed buy path',
      note: 'The two figures that answer the question, both measured at month S so '
        + 'they can be compared directly: what you are worth having never bought, '
        + 'against what you are worth having bought at that month and sold at S. '
        + 'Where the buy line sits above the flat rent line, buying won; its highest '
        + 'point is the best month to buy.',
      series: [
        {
          key: 'headlineRentWealth',
          description: 'What you are worth at month S if you never buy: cash on hand plus every '
            + 'month of leftover income, invested throughout. It does not depend on when '
            + 'you would have bought, so it plots flat - it is the benchmark the buy path '
            + 'has to beat. The rent-path section below breaks the same figure into its '
            + 'fixed-deposit and ETF parts.',
          label: 'Rent path: total wealth at month S (never buying)',
          color: 'rgb(5,150,105)',
          width: 3,
          defaultOn: true,
          from: 'rent',
          pick: r => r.finalWealth,
        },
        {
          key: 'headlineBuyWealth',
          description: 'What you are worth at month S if you buy at that month and sell at S: the '
            + 'investment balance plus the cash the sale leaves, less any financed '
            + 'shortfall. Read it as a curve over waiting time - its highest point is the '
            + 'best month to buy, and the gap to the flat rent line is what the decision '
            + 'is worth. The sections below show where the figure comes from.',
          label: 'Delayed buy path: total wealth at month S (buying at that month)',
          color: 'rgb(30,64,175)',
          width: 3,
          defaultOn: true,
          from: 'buy',
          pick: s => s.finalWealth,
        },
      ],
    },
    {
      id: 'rent-path',
      title: 'Rent path: rental costs and savings',
      note: 'Never buys, so no purchase month applies: each point shows where the '
        + 'renter stands at that month on the x-axis. Any fixed deposit stays locked '
        + 'until month S, which is what sets its rate.',
      series: [
        {
          key: 'rentOnlyRentPaidToB',
          description: 'Rent plus other rental costs, totalled from today to that month for someone who '
            + 'never buys. Each month\'s rent grows at the rent increase rate and the other '
            + 'costs at their own rate, so the total curves upward. It is paid out of '
            + 'income as it goes, so it is never also deducted from the savings lines; the '
            + 'buy path pays exactly the same rent before its purchase.',
          label: 'Total rent paid so far (never buying)',
          color: 'rgb(20,83,45)',
          from: 'rentAtB',
          pick: r => r.rentPaid,
        },
        {
          key: 'rentFdAtB',
          description: 'The cash on hand you start with, grown to that month inside a fixed deposit '
            + 'that stays locked until the sale at month S. It compounds at the FD rate for '
            + 'the term equal to S, or at the investment return after purchase when no '
            + 'offered term matches S. Nothing is ever paid in or taken out, so it only '
            + 'grows. Add the ETF line to get the renter\'s total savings. ' 
            + 'Unavailable under the ETF-only strategy, where the deposit holds nothing.',
          label: 'Savings in FDs so far, locked till month S',
          color: 'rgb(134,239,172)',
          from: 'rentAtB',
          fdOnly: true,
          pick: r => r.fdBalance,
        },
        {
          key: 'rentEtfAtB',
          description: 'What the renter\'s monthly savings are worth at that month. Each month '
            + 'contributes income minus rent and other rental costs at the ETF APR, '
            + 'credited at the chosen payout frequency. A month that costs more than it '
            + 'brings in is taken out of this balance instead of a negative amount being '
            + 'invested, and the balance never goes below zero. Identical to the buy path\'s '
            + 'ETF line, because the ETF account does not depend on when you buy.',
          label: 'Savings in ETFs so far (never buying)',
          color: 'rgb(34,197,94)',
          from: 'rentAtB',
          pick: r => r.etfBalance,
        },
        {
          key: 'rentSavingsAtB',
          description: 'Everything the renter holds at that month: the fixed-deposit balance plus the '
            + 'ETF balance, so it is the sum of the two lines above. Compare it with the '
            + 'buy path\'s total at month B — the two differ only through the deposit rate, '
            + 'because the renter\'s deposit is locked to month S while the buyer\'s matches '
            + 'month B.',
          label: 'Total savings so far (never buying, FD + ETF)',
          color: 'rgb(21,128,61)',
          from: 'rentAtB',
          pick: r => r.investments,
        },
      ],
    },
    {
      id: 'home-value',
      title: 'Buy path: home value',
      note: 'Each point is the case where you buy at that month, so B = the x-axis month.',
      series: [
        {
          key: 'priceAtB',
          description: 'What the house costs if you buy at month B. The target price you enter is '
            + 'treated as today\'s value and compounded at the home appreciation rate for '
            + 'B/12 years. It sets the closing costs, caps the down payment, and together '
            + 'with the down payment fixes the loan.',
          label: 'House value at month B (purchase price)',
          color: 'rgb(147,51,234)',
          from: 'buy',
          pick: s => s.priceAtPurchase,
        },
        {
          key: 'priceAtS',
          description: 'What the house is worth when it is sold at month S: today\'s price compounded '
            + 'at the appreciation rate for S/12 years. It does not depend on when you '
            + 'bought, so it plots flat. Selling costs are a percentage of it, and it '
            + 'drives the cash left in hand after the sale.',
          label: 'House value at month S (sale price)',
          color: 'rgb(216,180,254)',
          from: 'buy',
          pick: s => s.priceAtSale,
        },
      ],
    },
    {
      id: 'waiting-period',
      title: 'Buy path: waiting period investments',
      note: 'Each point is the case where you buy at that month, so B = the x-axis month. '
        + 'Saving from today up to the purchase at month B. The deposit is '
        + 'matched to month B, because the money is needed then.',
      series: [
        {
          key: 'buyFdAtB',
          description: 'The cash on hand grown to the purchase, in a deposit chosen to match the '
            + 'wait itself. It uses the FD rate for the term exactly equal to B (12, 24, 36 '
            + 'or 60 months) and otherwise falls back to the investment return after '
            + 'purchase. It parts from the rent path\'s deposit line only at those matching '
            + 'months, because the renter\'s deposit is locked to month S instead. ' 
            + 'Unavailable under the ETF-only strategy, where the deposit holds nothing.',
          label: 'Savings in FDs at month B, matched to month B',
          color: 'rgb(252,211,77)',
          from: 'buy',
          fdOnly: true,
          pick: s => s.fdBalanceAtPurchase,
        },
        {
          key: 'buyEtfAtB',
          description: 'The buyer\'s monthly savings at the moment of purchase: income minus rent and '
            + 'other rental costs, invested each month at the ETF APR. A month whose costs '
            + 'exceed income is drawn from this balance rather than invested as a negative '
            + 'amount, and the balance is floored at zero. It is the same line as the rent '
            + 'path\'s ETF balance, since the ETF account does not depend on the horizon.',
          label: 'Savings in ETFs at month B (buying at B)',
          color: 'rgb(245,158,11)',
          from: 'buy',
          pick: s => s.etfBalanceAtPurchase,
        },
        {
          key: 'buySavingsAtB',
          description: 'The whole pot available when you buy: the fixed-deposit balance plus the ETF '
            + 'balance at month B. This is what the purchase draws on — closing costs come '
            + 'out of it first, then the down payment. The purchase section splits exactly '
            + 'this amount into those two parts.',
          label: 'Total savings at month B (buying at B, FD + ETF)',
          color: 'rgb(180,83,9)',
          from: 'buy',
          pick: s => s.investmentsAtPurchase,
        },
      ],
    },
    {
      id: 'purchase',
      title: 'Buy path: the purchase at month B',
      note: 'Each point is the case where you buy at that month, so B = the x-axis month. '
        + 'The savings at month B, split into what the purchase consumes. '
        + '"Available" is savings less closing costs; "used" is what actually '
        + 'goes in, capped at the price and reduced by an insurance premium paid '
        + 'in cash. The two coincide unless one of those bites.',
      series: [
        {
          key: 'downPaymentAvailable',
          description: 'What is left for a down payment once the closing costs are paid: total '
            + 'savings at month B minus those costs. This is raw arithmetic, so it can '
            + 'exceed the house price or fall below zero. Add the closing-costs line and '
            + 'you get total savings at month B exactly.',
          label: 'Down payment available at month B',
          color: 'rgb(225,29,72)',
          from: 'buy',
          pick: s => s.availableForDownPayment,
        },
        {
          key: 'closingCosts',
          description: 'The buyer\'s closing costs, charged as a percentage of the purchase price at '
            + 'month B, so they grow as the house appreciates. They come out of savings '
            + 'before any down payment is set aside. Together with the down payment '
            + 'available they account for the whole savings pot.',
          label: 'Purchase closing costs at month B',
          color: 'rgb(253,164,175)',
          from: 'buy',
          pick: s => s.purchaseClosingCosts,
        },
        {
          /* Plotted as the sum of the two lines above, and dashed so that when
             "Total savings at month B" is also ticked you can see it land exactly
             on top of it. Down payment available + closing costs is the savings
             pot by definition, so the two lines coincide. */
          key: 'purchaseTotal',
          description: 'The two lines above added together, drawn dashed so you can watch it land '
            + 'exactly on top of "total savings at month B". It is a check rather than new '
            + 'information: down payment available plus closing costs is the savings pot by '
            + 'definition. If it ever parted from the solid line, the purchase arithmetic '
            + 'would be wrong.',
          label: 'Down payment + closing costs (= total savings at month B, buying at B)',
          color: 'rgb(159,18,57)',
          dash: [6, 4],
          from: 'buy',
          pick: s => s.availableForDownPayment + s.purchaseClosingCosts,
        },
        {
          /* Not the same as "available": this is clamped to the purchase price,
             floored at zero, and reduced by the insurance premium when that is
             paid in cash. It is the figure that sizes the mortgage. */
          key: 'downPaymentUsed',
          description: 'The down payment that actually goes into the house, and the figure that '
            + 'sizes the mortgage. It is the available amount capped at the purchase price, '
            + 'floored at zero, and reduced by the insurance premium when you choose to pay '
            + 'that in cash. It sits on top of the "available" line unless one of those '
            + 'three adjustments bites.',
          label: 'Down payment actually used at month B',
          color: 'rgb(251,113,133)',
          from: 'buy',
          pick: s => s.downPaymentUsed,
        },
        {
          /* Zero once the down payment reaches 20% of the price, or when the
             insurance option is switched off. Deliberately last in the section:
             it is NOT part of the "available + closing costs" identity above,
             because the premium is either rolled into the loan or taken out of
             the down payment rather than added on top of the savings. */
          key: 'mortgageInsurance',
          description: 'The mortgage default insurance premium required at month B, given the down '
            + 'payment reached by then. It is a percentage of the loan, taken from the rate '
            + 'bands or from your custom rate, and it drops to zero once the down payment '
            + 'reaches 20% of the price. It sits outside the down payment plus closing costs '
            + 'total, because the premium is either added to the loan or taken out of the '
            + 'down payment rather than paid on top of savings.',
          label: 'Required mortgage default insurance at month B',
          color: 'rgb(219,39,119)',
          from: 'buy',
          pick: s => s.mortgageInsurancePremium,
        },
      ],
    },
    {
      id: 'ownership',
      title: 'Buy path: ownership period and sale',
      note: 'Each point is the case where you buy at that month, so B = the x-axis month. '
        + 'Owning the home from month B to month S, then selling.',
      series: [
        {
          /* This account earns the "investment return after purchase", not the
             ETF APR, so it is not labelled as ETFs. */
          key: 'investmentsAtS',
          description: 'The investment account from the purchase through to the sale, valued at '
            + 'month S. It opens with whatever savings survived the purchase, then each '
            + 'month adds income minus the mortgage payment and the running costs at the '
            + 'investment return after purchase. A shortfall is taken out instead, and the '
            + 'balance never goes below zero. Add the cash left after selling to get total '
            + 'wealth if selling.',
          label: 'Savings invested from month B to S, valued at month S',
          color: 'rgb(125,211,252)',
          from: 'buy',
          pick: s => s.investmentsAtSale,
        },
        {
          key: 'interestPaid',
          description: 'All the mortgage interest paid between the purchase at month B and the sale '
            + 'at month S, accumulated month by month from the outstanding balance. Buying '
            + 'later means a bigger down payment, a smaller loan and less interest. It is a '
            + 'pure cost: unlike the principal, none of it comes back to you as equity.',
          label: 'Total mortgage interest paid, month B to S',
          color: 'rgb(148,163,184)',
          from: 'buy',
          pick: s => s.interestPaid,
        },
        {
          key: 'mortgageBalanceAtS',
          description: 'How much of the loan is still owed when the house is sold. The loan is '
            + 'amortised from the purchase over the full mortgage term at the mortgage rate '
            + '— delaying the purchase does not shorten the term — and payments stop if the '
            + 'term ends before month S. It is subtracted from the net sale proceeds to '
            + 'give the cash in hand.',
          label: 'Mortgage balance still owed at month S',
          color: 'rgb(15,23,42)',
          from: 'buy',
          pick: s => s.mortgageBalanceAtSale,
        },
        {
          /* Sale price less selling costs less the outstanding mortgage. Goes
             negative when the sale cannot clear the loan. */
          key: 'cashAfterSale',
          description: 'What the sale leaves you holding: the sale price at month S, less the '
            + 'selling costs (a percentage of it plus the fixed fees), less the mortgage '
            + 'balance still owed. It goes negative if the sale cannot clear the loan. Add '
            + 'the investment balance at month S to get total wealth if selling.',
          label: 'Cash in hand after selling at month S',
          color: 'rgb(2,132,199)',
          from: 'buy',
          pick: s => s.equityAtSale,
        },
        {
          key: 'wealthIfSelling',
          description: 'The buy path\'s answer: what you are worth at month S if you sell. It is the '
            + 'investment balance at month S plus the cash left after selling, less any '
            + 'financed shortfall. Compare it against the rent path\'s total savings to see '
            + 'whether buying at month B beat renting.',
          label: 'Total wealth if selling at month S',
          color: 'rgb(37,99,235)',
          width: 3,
          from: 'buy',
          pick: s => s.finalWealth,
        },
        {
          key: 'wealthIfKeeping',
          description: 'What you are worth at month S if you keep the house instead of selling. Same '
            + 'as the selling figure, but the house is valued at its full sale price with '
            + 'no selling costs deducted — so this line sits above the selling line by '
            + 'exactly those costs. Useful when month S is only a valuation point rather '
            + 'than a plan.',
          label: 'Total wealth if keeping the home at month S',
          color: 'rgb(129,140,248)',
          from: 'buy',
          pick: s => s.wealthIfKeepingHome,
        },
      ],
    },
  ];

  /** Every series across every section, flattened. */
  function all() {
    return SECTIONS.reduce((acc, section) => acc.concat(section.series), []);
  }

  /* Keys index both the check-box tree and the chart's dataset map, so a
     duplicate would silently drop a line. Fail loudly instead. */
  (function assertKeysUnique() {
    const seen = new Set();
    all().forEach(spec => {
      if (seen.has(spec.key)) throw new Error('series.js: duplicate key ' + spec.key);
      seen.add(spec.key);
    });
  })();

  /** Look-up by key, for the chart and the controls. */
  function byKey(key) {
    return all().find(spec => spec.key === key);
  }

  return { SECTIONS, all, byKey };
})();
