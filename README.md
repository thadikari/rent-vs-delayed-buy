# Rent vs Delayed Buy — optimal home purchase timing calculator

**[Open the calculator](https://thadikari.github.io/rent-vs-delayed-buy/)**

Is it better to buy a home now, or to keep renting for a while, invest the
difference, and buy later with a larger down payment? This tool answers that by
simulating every purchase month and comparing the result against never buying at
all.

Both paths are measured at the same moment — the sale month S — and both are
funded by the same monthly budget, with every housing cost paid out of it as it
falls due, so no cost is ever counted twice. That budget is what is left of your
pay once all non-housing living costs are met, not your gross income.

## What it tells you

A single verdict at the top, for example *"Buying in 14 months is the best
strategy!"*, followed by 23 optional charts breaking down where the number comes
from: the down payment, the closing costs, the mortgage and its insurance
premium, the interest, the sale proceeds and the total wealth on each path.

With the shipped defaults the best month to buy is the month the down payment
crosses 20% of the price and the mortgage default insurance premium disappears.

## What it models

- Rent and other rental costs, each growing at its own rate
- Cash on hand and monthly savings, in ETFs or in a fixed deposit matching the wait
- Home appreciation to the purchase month and again to the sale
- CMHC mortgage default insurance bands by down-payment ratio, capitalised or paid in cash
- Ontario-style closing costs, property tax, maintenance, home insurance and utilities
- Mortgage amortisation over the full term from the purchase month
- Selling costs as a percentage of the sale price plus fixed fees

Defaults are a plausible Canadian mid-market case: a $700,000 home, $3,100
rent, $6,500 a month for housing and saving, a 4.5% five-year fixed mortgage,
and a ten-year hold. Change any of them.

## Privacy

Everything is calculated in your browser. There is no server, no analytics, no
cookies and no storage, and nothing you type is transmitted or saved. The page
loads Tailwind, Chart.js and the GitHub button from CDNs; none of them receive
your inputs.

## Running it locally

Clone the repository and open `index.html` in a browser — there is no build step
and no dependencies to install. An internet connection is needed for the
Tailwind and Chart.js CDN scripts.

## How the code is laid out

    index.html            the form, the header and the analysis section
    js/model.js           the whole financial model, pure computation
    js/inputs.js          the only place the DOM and the model meet
    js/series.js          the catalogue of every plottable line
    js/series-controls.js the tick-box tree that doubles as the legend
    js/line-chart.js      Chart.js configuration
    js/heatmap.js         a hand-drawn wealth surface, hidden unless ?dev
    js/app.js             wiring: read the form, run the model, redraw

Read `js/model.js` alone and you have the whole logic; its header documents the
timeline, the rule that keeps the comparison fair, and the two rate conventions.

## Caveats

The model holds income constant, holds the mortgage rate for the whole
amortisation rather than renewing every five years, enforces no minimum down
payment, and does not charge the 8% Ontario PST on the insurance premium.
