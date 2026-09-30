/* model.js — the financial model behind the Rent vs Delayed Buy calculator.
 *
 * This file is pure computation. Nothing in it touches the DOM, Chart.js or a
 * canvas: it takes a plain inputs object (inputs.js builds one from the form)
 * and returns plain result objects. Read this file alone and you have the whole
 * logic of the tool.
 *
 *
 * THE QUESTION
 * ------------
 * Is it better to buy a home now, or to keep renting for a while, invest the
 * difference, and buy later with a larger down payment?
 *
 *
 * THE TIMELINE
 * ------------
 *   month 0                month B                        month S
 *   today                  purchase                       sale
 *     |----------------------|------------------------------|
 *     |    waiting phase     |       ownership phase        |
 *     |    rent + invest     |  mortgage + running costs    |
 *
 *   Rent path (never buys):
 *     |------------------------ rent + invest ---------------|
 *
 *   B = the purchase delay, in months (B = 0 means buy today).
 *   S = the sale month, counted from today. S >= B always.
 *
 * Both paths are measured at the same moment, Month S, so their final wealth is
 * directly comparable.
 *
 *
 * THE RULE THAT KEEPS THE COMPARISON FAIR
 * ---------------------------------------
 * Both paths receive the same income every month, and every housing cost is paid
 * out of that income. That figure is not gross pay: it is what is left of it once
 * every non-housing living cost has been met, because the model has no other
 * expense of its own and invests every dollar housing does not consume.
 *
 *   while renting  ->  rent + other rental costs
 *   after buying   ->  mortgage payment + property tax + maintenance
 *                      + home insurance + utilities
 *
 * Whatever income is left over that month is invested. A negative leftover is
 * never "invested": the month's gap is taken out of the investment balance
 * instead, and that balance is floored at zero. Anything it cannot cover is
 * recorded as a *shortfall* — housing cost that neither income nor savings could
 * meet. A shortfall is financed at the same rate the money would have earned and
 * is subtracted from final wealth, so it is debt rather than negative savings.
 *
 * Because every cost is paid out of cash flow, no cost is ever *also* subtracted
 * from the final wealth. That is what makes the two paths comparable, and it is
 * the easiest thing to get wrong when editing this file: if you add a new cost,
 * charge it to the monthly cash flow, not to the final total. The shortfall is
 * the one deduction, and it exists precisely so that a cost the cash flow could
 * not absorb is still counted once rather than quietly dropped.
 *
 *
 * RATE CONVENTIONS
 * ----------------
 * The inputs carry two kinds of annual rate, and they become monthly rates
 * differently. Mixing them up is a subtle source of error:
 *
 *   APRs — savings before the purchase, savings after it, mortgage interest.
 *          Nominal annual rates, quoted the way lenders and banks quote them:
 *              monthly = APR / 12
 *
 *   Growth rates — rent, other rental costs, home appreciation.
 *          Effective annual rates: "3% a year" means a year compounds to 3%.
 *              monthly = (1 + annual)^(1/12) - 1
 */

window.RentVsBuy = window.RentVsBuy || {};
window.RentVsBuy.model = (function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  /** At or above this down-payment share, no default insurance is required. */
  const INSURANCE_FREE_DOWN_PAYMENT_RATIO = 0.20;

  /* Mortgage default insurance premium as a share of the loan, by down-payment
     ratio, used when the custom rate is left at 0. Highest ratio first: the
     lookup takes the first band the ratio reaches. Kept in step with the band
     note rendered in index.html.

     These are CMHC's published rates for a standard purchase with a traditional
     down payment and an amortisation of 25 years or less, expressed by down
     payment rather than by loan-to-value: 20% down is 80% LTV.

     Two things they leave out. Below 5% down the loan is not insurable at all,
     so the bottom band is a stand-in for a purchase that could not happen; the
     model has no minimum-down-payment rule to reject it. And in Ontario the
     premium attracts 8% provincial sales tax, payable in cash at closing and
     never capitalised, which the model does not charge. */
  const MD_INSURANCE_BANDS = [
    { minDownPaymentRatio: 0.20, rate: 0 },
    { minDownPaymentRatio: 0.15, rate: 0.028 },
    { minDownPaymentRatio: 0.10, rate: 0.031 },
    { minDownPaymentRatio: 0.05, rate: 0.040 },
    { minDownPaymentRatio: 0, rate: 0.040 },
  ];

  /** Above this price no default insurance is available, so 20% down is the floor. */
  const INSURABLE_PRICE_CEILING = 1500000;

  /**
   * The smallest down payment a lender may accept, in Canada: 5% of the first
   * $500,000, 10% of the part above that, and 20% once the price passes the
   * insurable ceiling. A purchase with less than this cannot happen at all, which
   * is a different thing from a purchase that is merely a bad idea.
   */
  function minimumDownPayment(price) {
    if (price <= 0) return 0;
    if (price > INSURABLE_PRICE_CEILING) return 0.20 * price;
    if (price > 500000) return 0.05 * 500000 + 0.10 * (price - 500000);
    return 0.05 * price;
  }

  // -------------------------------------------------------------- rate helpers

  /** Monthly equivalent of an effective annual growth rate. See RATE CONVENTIONS. */
  function effectiveMonthlyRate(annualRate) {
    if (annualRate <= -1) return -1;
    return Math.pow(1 + annualRate, 1 / 12) - 1;
  }

  /** The level payment that fully amortises `loanAmount` over `months`. */
  function loanMonthlyPayment(loanAmount, monthlyRate, months) {
    if (months <= 0 || loanAmount <= 0) return 0;
    if (monthlyRate === 0) return loanAmount / months;
    const growth = Math.pow(1 + monthlyRate, months);
    return (loanAmount * monthlyRate * growth) / (growth - 1);
  }

  // ------------------------------------------------------------------- savings

  /*
   * Savings, in both phases, are one balance earning one rate.
   *
   * The rate is quoted as an APR and applied a twelfth at a time, every month:
   * the balance grows, then the month's contribution lands (so a contribution
   * earns nothing in the month it arrives). A negative contribution — a month
   * that costs more than it brings in — is met from the balance instead, and
   * whatever the balance cannot cover becomes *shortfall*: housing cost that
   * neither income nor savings could meet, financed at the same rate and
   * subtracted from final wealth.
   *
   * The balance itself can open below zero, when closing costs alone exhaust the
   * savings at Month B. That debt compounds at the same rate the shortfall does,
   * and income pays it down before anything is invested; since wealth is
   * investments minus shortfall, which of the two carries it makes no difference.
   */
  function runPhase(monthlyRate, openingBalance, months, contributionFor, openingShortfall) {
    let balance = openingBalance;
    let shortfall = openingShortfall || 0;

    /* A negative contribution is a month whose housing cost outran the budget.
       The arithmetic copes - it borrows - but a scenario built on borrowing is
       one the page has to own up to, so the months are counted here. */
    let monthsOverBudget = 0;
    let firstOverBudget = null;

    for (let month = 0; month < months; month++) {
      const contribution = contributionFor(month);
      if (contribution < 0) {
        monthsOverBudget += 1;
        if (firstOverBudget === null) firstOverBudget = month;
      }
      const grown = balance * (1 + monthlyRate);
      shortfall *= 1 + monthlyRate;                 // last month's gap keeps costing

      if (contribution >= 0) {
        balance = grown + contribution;
      } else {
        const covered = Math.min(-contribution, Math.max(0, grown));
        balance = grown - covered;
        shortfall += -contribution - covered;
      }
    }

    return { investments: balance, shortfall, monthsOverBudget, firstOverBudget };
  }

  /** Everything a renter pays in `month` (0-based), rent plus other rental costs. */
  function rentalCostInMonth(inputs, month) {
    const rent = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowthMonthly, month);
    const other = inputs.otherRentalMonthly * Math.pow(1 + inputs.otherRentalGrowthMonthly, month);
    return rent + other;
  }

  /**
   * Rent for `months` months, investing whatever income is left each month.
   *
   * Shared by both paths: the buy path runs it up to Month B, and the rent path
   * runs it all the way to Month S. That is the only difference between them
   * before a purchase happens — which is why the savings they hold at Month B
   * are the same number.
   */
  function runWaitingPhase(inputs, months) {
    let rentPaid = 0;
    const contributionFor = month => {
      const cost = rentalCostInMonth(inputs, month);
      rentPaid += cost;
      return inputs.monthlyIncome - cost;
    };

    const phase = runPhase(inputs.waitingMonthlyRate, inputs.cashOnHand, months,
      contributionFor, 0);
    return {
      rentPaid,
      investments: phase.investments,
      shortfall: phase.shortfall,
      monthsOverBudget: phase.monthsOverBudget,
      firstOverBudget: phase.firstOverBudget,
    };
  }

  // -------------------------------------------------- phase 2: the purchase

  /** The house is priced at today's value and appreciates from there. */
  function homePriceAtMonth(inputs, month) {
    return inputs.homePriceToday * Math.pow(1 + inputs.homeAppreciationAnnual, month / 12);
  }

  function bandedInsuranceRate(downPaymentRatio) {
    const band = MD_INSURANCE_BANDS.find(b => downPaymentRatio >= b.minDownPaymentRatio);
    return band ? band.rate : 0;
  }

  /** Whether default insurance applies, and what the premium would be. */
  function resolveMortgageInsurance(inputs, priceAtPurchase, downPayment) {
    const downPaymentRatio = priceAtPurchase > 0 ? downPayment / priceAtPurchase : 0;

    if (inputs.mdInsuranceMode === 'none'
        || downPaymentRatio >= INSURANCE_FREE_DOWN_PAYMENT_RATIO) {
      return { applied: false, rate: 0, premium: 0, downPaymentRatio };
    }

    const rate = inputs.mdInsuranceCustomRate > 0
      ? inputs.mdInsuranceCustomRate
      : bandedInsuranceRate(downPaymentRatio);
    const premium = rate * Math.max(0, priceAtPurchase - downPayment);

    return { applied: rate > 0, rate, premium, downPaymentRatio };
  }

  /**
   * Turn the pool of investments at Month B into a purchase: pay the closing
   * costs, commit what is left to the down payment, settle the insurance
   * question, and size the loan.
   */
  function planPurchase(inputs, priceAtPurchase, poolAtPurchase) {
    // Closing costs come out first; only what survives can fund a down payment.
    const closingCosts = inputs.purchaseClosingCostRate * priceAtPurchase;
    const availableForDownPayment = poolAtPurchase - closingCosts;

    // Everything available goes in, but never more than the house costs. This
    // can be 0 when closing costs alone exhaust the pool.
    const downPaymentFunded = Math.min(Math.max(0, availableForDownPayment), priceAtPurchase);

    const insurance = resolveMortgageInsurance(inputs, priceAtPurchase, downPaymentFunded);

    /* Two ways to handle the premium:
         'capitalized'  -> roll it into the loan, leaving the down payment alone
         'down-payment' -> pay it in cash, shrinking the down payment

       Only what the down payment can actually cover is paid in cash; the rest
       has to be borrowed like any other premium. Dropping that remainder would
       hand the buyer a smaller loan than the capitalized option for no reason. */
    const paidInCash = insurance.applied && inputs.mdInsuranceMode === 'down-payment';
    const premiumFromDownPayment = paidInCash
      ? Math.min(insurance.premium, downPaymentFunded)
      : 0;
    const premiumFinanced = insurance.applied
      ? insurance.premium - premiumFromDownPayment
      : 0;

    const downPaymentUsed = downPaymentFunded - premiumFromDownPayment;
    const loanAmount = Math.max(0, priceAtPurchase - downPaymentUsed) + premiumFinanced;

    /* Either way the same cash leaves the pool. 'capitalized' spends the funded
       down payment and borrows the premium; 'down-payment' spends the reduced
       down payment plus the premium, which adds back up to the funded amount. */
    const investmentsAfterPurchase = availableForDownPayment - downPaymentFunded;

    return {
      closingCosts,
      availableForDownPayment,
      downPaymentUsed,
      loanAmount,
      insurance,
      investmentsAfterPurchase,
    };
  }

  // ------------------------------------------------- phase 3: owning the home

  /**
   * Own the home from Month B to Month S. Each month the mortgage payment and
   * the running costs are paid out of income, and the remainder is invested (or,
   * more often, the shortfall is drawn from investments).
   */
  function runOwnershipPhase(inputs, purchase, priceAtPurchase, holdMonths, openingShortfall) {
    /* The amortisation period starts at the purchase, so waiting longer to buy
       does not shorten the mortgage. */
    const monthlyPayment = loanMonthlyPayment(
      purchase.loanAmount, inputs.mortgageMonthlyRate, inputs.mortgageTermMonths);

    // Property tax, maintenance and home insurance are all charged as a share of
    // the home's value, so they can be summed into one rate.
    const valueLinkedCostRate =
      inputs.propertyTaxRate + inputs.maintenanceRate + inputs.homeInsuranceRate;

    let mortgageBalance = purchase.loanAmount;
    let interestPaid = 0;
    let principalPaid = 0;
    let ownershipCosts = 0;
    let paymentsMade = 0;

    /* Called once per month, in order, by runPhase. It advances the mortgage and
       the running costs for that month and hands back what income has left for
       investing - negative when the month costs more than it brings in. */
    const contributionFor = index => {
      const month = index + 1;              // month 1 is the first month owned
      let payment = 0;
      if (mortgageBalance > 0 && month <= inputs.mortgageTermMonths) {
        const interest = mortgageBalance * inputs.mortgageMonthlyRate;
        // The final payment is only as large as what is left to settle.
        payment = Math.min(monthlyPayment, mortgageBalance + interest);
        mortgageBalance = mortgageBalance + interest - payment;
        if (mortgageBalance < 1e-6) mortgageBalance = 0;
        interestPaid += interest;
        principalPaid += payment - interest;
        paymentsMade += 1;
      }

      /* Running costs track the home's value, so they grow with it — and unlike
         the mortgage they keep running for the whole holding period, including
         any months after the loan has been paid off. */
      const homeValue = priceAtPurchase * Math.pow(1 + inputs.homeAppreciationMonthly, month);
      const recurringCosts = (valueLinkedCostRate * homeValue) / 12 + inputs.utilitiesMonthly;
      ownershipCosts += recurringCosts;

      return inputs.monthlyIncome - payment - recurringCosts;
    };

    // Opens with whatever savings survived the purchase, which can be negative.
    const phase = runPhase(inputs.ownershipMonthlyRate, purchase.investmentsAfterPurchase,
      holdMonths, contributionFor, openingShortfall);

    return {
      monthlyPayment,
      mortgageBalance,
      investments: phase.investments,
      shortfall: phase.shortfall,
      monthsOverBudget: phase.monthsOverBudget,
      firstOverBudget: phase.firstOverBudget,
      interestPaid,
      principalPaid,
      ownershipCosts,
      paymentsMade,
    };
  }

  // -------------------------------------------------- phase 4: selling up

  /** Sell at Month S: pay the selling costs, clear the mortgage, keep the rest. */
  function settleSale(inputs, priceAtSale, mortgageBalance) {
    const sellingCosts = priceAtSale * inputs.sellingCostRate + inputs.fixedSellingFees;
    const netProceeds = priceAtSale - sellingCosts;
    // Negative equity is possible; it is carried through as a negative number
    // rather than clamped, so it is charged against wealth exactly once.
    return { sellingCosts, netProceeds, equity: netProceeds - mortgageBalance };
  }

  // ------------------------------------------------------------ the two paths

  /**
   * The rent path: never buys, just rents and invests all the way to Month S.
   *
   * It does not depend on B at all, which is why it plots as a flat reference
   * line.
   */
  function simulateRentPath(inputs, saleMonth) {
    const waiting = runWaitingPhase(inputs, saleMonth);
    return {
      saleMonth,
      rentPaid: waiting.rentPaid,
      investments: waiting.investments,
      shortfall: waiting.shortfall,
      /* Months where the rent alone outran the budget. The rent path is the
         benchmark, so if it cannot be afforded neither comparison means much. */
      monthsOverBudget: waiting.monthsOverBudget,
      firstOverBudgetMonth: waiting.firstOverBudget,
      // Savings less the housing cost the cash flow could not absorb.
      finalWealth: waiting.investments - waiting.shortfall,
    };
  }

  /**
   * The rent path's position partway through, at `month`.
   *
   * Same path as simulateRentPath — this renter never buys — just read earlier.
   * `saleMonth` is carried only so the result can say which horizon it belongs
   * to; nothing before the purchase depends on it.
   */
  function simulateRentPathAt(inputs, month, saleMonth) {
    const waiting = runWaitingPhase(inputs, month);
    return {
      month,
      saleMonth,
      rentPaid: waiting.rentPaid,
      investments: waiting.investments,
      shortfall: waiting.shortfall,
    };
  }

  /** The buy path: wait, buy at Month B, own the home, sell at Month S. */
  function simulateBuyPath(inputs, purchaseMonth, saleMonth) {
    const priceAtPurchase = homePriceAtMonth(inputs, purchaseMonth);
    const priceAtSale = homePriceAtMonth(inputs, saleMonth);
    const holdMonths = Math.max(0, saleMonth - purchaseMonth);

    const waiting = runWaitingPhase(inputs, purchaseMonth);
    const purchase = planPurchase(inputs, priceAtPurchase, waiting.investments);
    const ownership = runOwnershipPhase(
      inputs, purchase, priceAtPurchase, holdMonths, waiting.shortfall);
    const sale = settleSale(inputs, priceAtSale, ownership.mortgageBalance);
    const minimumDown = minimumDownPayment(priceAtPurchase);

    return {
      purchaseMonth,
      saleMonth,
      holdMonths,
      priceAtPurchase,
      priceAtSale,

      // phase 1 — the wait
      rentPaidDuringWait: waiting.rentPaid,
      investmentsAtPurchase: waiting.investments,
      shortfallAtPurchase: waiting.shortfall,

      /* Could this purchase happen? A down payment below the legal minimum is
         not a worse deal, it is not a deal: no lender may write it. Months that
         fail this are left out of the chart and out of the verdict. */
      minimumDownPayment: minimumDown,
      purchasePossible: priceAtPurchase > 0
        && purchase.availableForDownPayment >= minimumDown - 1e-6,
      downPaymentShortfall: Math.max(0, minimumDown - purchase.availableForDownPayment),

      /* Months of ownership whose housing cost outran the budget, and the first
         of them counted from today. */
      monthsOverBudget: ownership.monthsOverBudget,
      firstOverBudgetMonth: ownership.firstOverBudget === null
        ? null
        : purchaseMonth + 1 + ownership.firstOverBudget,

      // phase 2 — the purchase
      purchaseClosingCosts: purchase.closingCosts,
      availableForDownPayment: purchase.availableForDownPayment,
      downPaymentUsed: purchase.downPaymentUsed,
      downPaymentRatio: purchase.insurance.downPaymentRatio,
      loanAmount: purchase.loanAmount,
      mortgageInsuranceApplied: purchase.insurance.applied,
      mortgageInsuranceRate: purchase.insurance.rate,
      mortgageInsurancePremium: purchase.insurance.premium,

      // phase 3 — ownership
      monthlyMortgagePayment: ownership.monthlyPayment,
      mortgagePaymentsMade: ownership.paymentsMade,
      mortgageBalanceAtSale: ownership.mortgageBalance,
      interestPaid: ownership.interestPaid,
      principalPaid: ownership.principalPaid,
      ownershipCosts: ownership.ownershipCosts,
      investmentsAtSale: ownership.investments,
      shortfallAtSale: ownership.shortfall,

      // phase 4 — the sale
      sellingCosts: sale.sellingCosts,
      netSaleProceeds: sale.netProceeds,
      equityAtSale: sale.equity,

      /* The two answers the chart plots. Selling realises the equity and pays the
         selling costs; keeping the home skips both. Both are net of any shortfall,
         which is real debt even though it never showed up as negative savings. */
      finalWealth: ownership.investments - ownership.shortfall + sale.equity,
      wealthIfKeepingHome: ownership.investments - ownership.shortfall
        + (priceAtSale - ownership.mortgageBalance),
    };
  }

  // ---------------------------------------------------------- the verdict

  /**
   * The answer the whole tool exists to give: does buying beat renting, and if
   * it does, which month is the best one to buy?
   *
   * Takes the rent-path outcome and one buy-path outcome per purchase month, all
   * measured at Month S, and picks the month with the highest final wealth. Ties
   * go to the earlier month, because waiting longer for the same result is not
   * worth it. Buying only "wins" if the best month actually beats never buying.
   */
  function bestPurchase(rentResult, buyScenarios) {
    const rentWealth = rentResult.finalWealth;
    const empty = {
      rentWealth,
      buyingWins: false,
      bestMonth: null,
      bestWealth: null,
      margin: 0,
      winningMonths: 0,
      lastWinningMonth: null,
      anyPossible: false,
      impossibleMonths: 0,
      firstPossibleMonth: null,
      bothNegative: false,
      monthsOverBudget: 0,
      smallestShortfall: 0,
    };
    if (!buyScenarios || buyScenarios.length === 0) return empty;

    /* Only months where the purchase could actually be made are candidates. A
       month with too small a down payment is not a worse option to be ranked
       below the others; it is not an option. */
    const possible = buyScenarios.filter(scenario => scenario.purchasePossible);
    if (possible.length === 0) {
      return Object.assign({}, empty, {
        anyPossible: false,
        impossibleMonths: buyScenarios.length,
        firstPossibleMonth: null,
        // What stopped the closest attempt, for the page to report.
        smallestShortfall: Math.min.apply(
          null, buyScenarios.map(scenario => scenario.downPaymentShortfall)),
      });
    }

    let best = possible[0];
    let winningMonths = 0;
    let lastWinningMonth = null;
    possible.forEach(scenario => {
      // Strictly greater, so the earliest of equally good months is kept.
      if (scenario.finalWealth > best.finalWealth) best = scenario;
      if (scenario.finalWealth > rentWealth) {
        winningMonths += 1;
        lastWinningMonth = scenario.purchaseMonth;
      }
    });

    return {
      rentWealth,
      buyingWins: best.finalWealth > rentWealth,
      bestMonth: best.purchaseMonth,
      bestWealth: best.finalWealth,
      // Positive when buying wins, negative when renting does.
      margin: best.finalWealth - rentWealth,
      winningMonths,
      lastWinningMonth,
      anyPossible: true,
      impossibleMonths: buyScenarios.length - possible.length,
      firstPossibleMonth: possible[0].purchaseMonth,
      // Both paths in the red: the better of the two is only the lesser loss.
      bothNegative: best.finalWealth < 0 && rentWealth < 0,
      // The chosen month still has to be lived through.
      monthsOverBudget: best.monthsOverBudget,
    };
  }

  return {
    // Rate conversion, needed when building the inputs object.
    effectiveMonthlyRate,
    // The model itself.
    simulateRentPath,
    simulateRentPathAt,
    simulateBuyPath,
    // The conclusion drawn from a whole sweep of purchase months.
    bestPurchase,
  };
})();
