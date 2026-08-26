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
 * out of that income:
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
 *   APRs — ETF, fixed deposit, post-purchase investment, mortgage interest.
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

  /** Fixed-deposit terms the calculator offers, in months. */
  const FD_TERM_MONTHS = [12, 24, 36, 60];

  /** At or above this down-payment share, no default insurance is required. */
  const INSURANCE_FREE_DOWN_PAYMENT_RATIO = 0.20;

  /* Mortgage default insurance premium as a share of the loan, by down-payment
     ratio, used when the custom rate is left at 0. Highest ratio first: the
     lookup takes the first band the ratio reaches. Kept in step with the band
     note rendered in index.html. */
  const MD_INSURANCE_BANDS = [
    { minDownPaymentRatio: 0.20, rate: 0 },
    { minDownPaymentRatio: 0.15, rate: 0.0175 },
    { minDownPaymentRatio: 0.10, rate: 0.028 },
    { minDownPaymentRatio: 0.05, rate: 0.036 },
    { minDownPaymentRatio: 0, rate: 0.04 },
  ];

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

  // --------------------------------------------------------- investment account

  /* An investment account, advanced one month at a time.
   *
   * Return accrues every month on the opening balance, but is only *credited*
   * every `payoutMonths` — and until it is credited it does not itself earn
   * anything. That is how the ETF payout-frequency input behaves: it shifts when
   * return is realised without changing the underlying APR. payoutMonths = 1 is
   * ordinary monthly compounding.
   */
  function openAccount(openingBalance, monthlyRate, payoutMonths) {
    return {
      balance: openingBalance,
      accrued: 0,
      monthlyRate,
      payoutMonths: Math.max(1, payoutMonths),
      monthsElapsed: 0,
    };
  }

  /**
   * Advance one month: accrue return on the opening balance, then apply the
   * month's contribution (negative to withdraw). A contribution lands at the end
   * of the month, so it earns nothing that month.
   */
  function advanceOneMonth(account, contribution) {
    account.accrued += account.balance * account.monthlyRate;
    account.balance += contribution;
    account.monthsElapsed += 1;
    if (account.monthsElapsed % account.payoutMonths === 0) {
      account.balance += account.accrued;
      account.accrued = 0;
    }
  }

  /** Balance including return accrued but not yet credited. */
  function accountValue(account) {
    return account.balance + account.accrued;
  }

  /**
   * Take up to `amount` out of the account, never taking it below zero, and
   * return what was actually taken.
   *
   * Accrued return is credited first, because money being spent has to be in
   * hand. That slightly accelerates compounding in a month where the account is
   * drawn on, which only happens when income cannot cover housing.
   */
  function spendFromAccount(account, amount) {
    account.balance += account.accrued;
    account.accrued = 0;
    const taken = Math.min(amount, Math.max(0, account.balance));
    account.balance -= taken;
    return taken;
  }

  // ------------------------------------------------------ phase 1: the wait

  /*
   * While waiting to buy, savings sit in two places:
   *
   *   cash on hand    -> a fixed deposit, if one matches the wait exactly
   *   monthly savings -> ETFs
   *
   * The help text for the FD lock options is explicit that a fixed deposit is
   * only used when the wait *equals* an offered term, so this is an exact-term
   * lookup and not a "largest term that fits" search. Returns null when no FD
   * applies, in which case the caller falls back to the ongoing return.
   */
  function fdRateForHorizon(inputs, horizonMonths) {
    if (inputs.waitingStrategy !== 'fd-plus-etf' || !inputs.autoFdEnabled) return null;
    return FD_TERM_MONTHS.includes(horizonMonths) ? inputs.fdRates[horizonMonths] : null;
  }

  /** Which monthly rates apply to cash and to monthly savings over a given wait. */
  function waitingPeriodRates(inputs, horizonMonths) {
    // "ETF only" means exactly that: one return assumption, no FD split.
    if (inputs.waitingStrategy === 'etf-only') {
      return {
        cashMonthlyRate: inputs.etfMonthlyRate,
        cashPayoutMonths: inputs.etfPayoutMonths,
        savingsMonthlyRate: inputs.etfMonthlyRate,
        savingsPayoutMonths: inputs.etfPayoutMonths,
      };
    }
    const fdAnnualRate = fdRateForHorizon(inputs, horizonMonths);
    return {
      // No matching FD term: the cash earns the ongoing post-purchase return.
      cashMonthlyRate: fdAnnualRate === null ? inputs.postPurchaseMonthlyRate : fdAnnualRate / 12,
      cashPayoutMonths: 1,
      savingsMonthlyRate: inputs.etfMonthlyRate,
      savingsPayoutMonths: inputs.etfPayoutMonths,
    };
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
   * before a purchase happens.
   *
   * `rateHorizonMonths` is how long the money is committed for, which is what
   * picks the fixed-deposit term. It is normally the same as `months`, but the
   * two come apart when reading a renter's balance partway through: a renter who
   * never buys has locked their deposit until Month S, so their balance at
   * Month B still earns the S-matched rate.
   */
  function runWaitingPhase(inputs, months, rateHorizonMonths = months) {
    const rates = waitingPeriodRates(inputs, rateHorizonMonths);
    const cash = openAccount(inputs.cashOnHand, rates.cashMonthlyRate, rates.cashPayoutMonths);
    const savings = openAccount(0, rates.savingsMonthlyRate, rates.savingsPayoutMonths);
    let rentPaid = 0;

    /* Housing cost that neither income nor the savings pot could cover. It is
       financed at the same rate the money would have earned. */
    let shortfall = 0;

    for (let month = 0; month < months; month++) {
      const cost = rentalCostInMonth(inputs, month);
      rentPaid += cost;
      const leftover = inputs.monthlyIncome - cost;

      advanceOneMonth(cash, 0);                    // locked away, no contributions
      shortfall *= 1 + rates.savingsMonthlyRate;   // last month's gap keeps costing

      /* Only a positive leftover is ever invested. A negative one is met from
         the pot, and whatever the pot cannot cover becomes shortfall. */
      advanceOneMonth(savings, Math.max(0, leftover));
      if (leftover < 0) {
        shortfall += -leftover - spendFromAccount(savings, -leftover);
      }
    }

    const cashValue = accountValue(cash);
    const savingsValue = accountValue(savings);

    /* Split the pot by the instrument holding it, so the chart can show where the
       down payment came from. Under 'etf-only' the cash on hand is in ETFs as
       well, so the fixed deposit holds nothing and the ETF figure covers both.
       Either way inFixedDeposit + inEtfs === investments. */
    const usesFixedDeposit = inputs.waitingStrategy === 'fd-plus-etf';

    return {
      rentPaid,
      inFixedDeposit: usesFixedDeposit ? cashValue : 0,
      inEtfs: usesFixedDeposit ? savingsValue : cashValue + savingsValue,
      investments: cashValue + savingsValue,
      shortfall,
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
         'down-payment' -> pay it in cash, shrinking the down payment          */
    const paidInCash = insurance.applied && inputs.mdInsuranceMode === 'down-payment';
    const downPaymentUsed = paidInCash
      ? Math.max(0, downPaymentFunded - insurance.premium)
      : downPaymentFunded;

    let loanAmount = Math.max(0, priceAtPurchase - downPaymentUsed);
    if (insurance.applied && inputs.mdInsuranceMode === 'capitalized') {
      loanAmount += insurance.premium;
    }

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
    let investments = purchase.investmentsAfterPurchase;
    // Carried over from the wait, and still being financed.
    let shortfall = openingShortfall;
    let interestPaid = 0;
    let principalPaid = 0;
    let ownershipCosts = 0;
    let paymentsMade = 0;

    for (let month = 1; month <= holdMonths; month++) {
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

      /* Income covers this month's housing and the rest is invested. A month
         that costs more than it brings in is met from the balance instead, which
         is floored at zero — a negative amount is never invested. */
      const grown = investments * (1 + inputs.postPurchaseMonthlyRate);
      shortfall *= 1 + inputs.postPurchaseMonthlyRate;
      const leftover = inputs.monthlyIncome - payment - recurringCosts;

      if (leftover >= 0) {
        investments = grown + leftover;
      } else {
        const covered = Math.min(-leftover, Math.max(0, grown));
        investments = grown - covered;
        shortfall += -leftover - covered;
      }
    }

    return {
      monthlyPayment,
      mortgageBalance,
      investments,
      shortfall,
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
   * line. Its fixed deposit is matched against S, the only horizon it has.
   */
  function simulateRentPath(inputs, saleMonth) {
    const waiting = runWaitingPhase(inputs, saleMonth);
    return {
      saleMonth,
      rentPaid: waiting.rentPaid,
      investments: waiting.investments,
      fdBalance: waiting.inFixedDeposit,
      etfBalance: waiting.inEtfs,
      shortfall: waiting.shortfall,
      // Savings less the housing cost the cash flow could not absorb.
      finalWealth: waiting.investments - waiting.shortfall,
    };
  }

  /**
   * The rent path's position partway through, at `month`.
   *
   * Same path as simulateRentPath — this renter never buys — just read earlier.
   * The deposit stays locked until `saleMonth`, so it earns the S-matched rate
   * even though the balance is taken at `month`.
   */
  function simulateRentPathAt(inputs, month, saleMonth) {
    const waiting = runWaitingPhase(inputs, month, saleMonth);
    return {
      month,
      saleMonth,
      rentPaid: waiting.rentPaid,
      fdBalance: waiting.inFixedDeposit,
      etfBalance: waiting.inEtfs,
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
      /* How that pot was invested on the way to Month B. These two always sum to
         investmentsAtPurchase. */
      fdBalanceAtPurchase: waiting.inFixedDeposit,
      etfBalanceAtPurchase: waiting.inEtfs,

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

  return {
    // Consumed by inputs.js so the FD terms are defined in exactly one place.
    FD_TERM_MONTHS,
    // Rate conversion, needed when building the inputs object.
    effectiveMonthlyRate,
    // The model itself.
    simulateRentPath,
    simulateRentPathAt,
    simulateBuyPath,
  };
})();
