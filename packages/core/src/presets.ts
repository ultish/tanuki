import { concessionalRoom, nccRoom } from "./caps.js";
import type { Allocation, BucketId, Household, ScenarioDef } from "./types.js";

function alloc(entries: Allocation): Allocation {
  const out: Allocation = {};
  for (const [k, v] of Object.entries(entries) as [BucketId, number | undefined][]) {
    if (v && v > 0.5) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

function rest(lump: number, used: number): number {
  return Math.max(0, lump - used);
}

/**
 * Named lives for the lump. Super amounts are requested at the cap; the
 * engine clamps to remaining room and parks leftover in the offset.
 */
export function buildPresets(h: Household): ScenarioDef[] {
  const S = h.lumpSum;
  const ccYou = concessionalRoom(h.you, h.assumptions);
  const ccSpouse = concessionalRoom(h.spouse, h.assumptions);
  const nccYou = nccRoom(h.you, h.assumptions, h.assumptions.useNccBringForward);
  const nccSpouse = nccRoom(
    h.spouse,
    h.assumptions,
    h.assumptions.useNccBringForward,
  );

  const presets: ScenarioDef[] = [
    {
      id: "offset",
      label: "Park in offset",
      summary:
        "Put the whole lump in the home-loan offset.\n\nThe bank pretends you owe less, so you pay less interest. You can still take the cash out.\n\nNo shares. Boring on purpose, and you can undo it tomorrow.",
      group: "loan",
      allocation: alloc({ offset: S }),
    },
    {
      id: "repay",
      label: "Pay down the home loan",
      summary:
        "Send the whole lump straight at the mortgage.\n\nYou save the same interest as the offset. The cash is gone. You can't just pull it back out to buy shares later.\n\nSame maths as offset. Worse if you might want that money again.",
      group: "loan",
      allocation: alloc({ extra_repay: S }),
    },
    {
      id: "you-growth",
      label: "Growth shares, your name",
      summary:
        "Buy shares that are meant to go up in price, in your name, outside super. They don't pay much cash.\n\nYou can sell whenever you like. Tax on the little dividends, and on a sale, is at your high rate, about 47%.\n\nEasy to get at. Tax is the painful bit.",
      group: "taxable",
      allocation: alloc({ taxable_you_growth: S }),
    },
    {
      id: "you-income",
      label: "Dividend shares, your name",
      summary:
        "Buy shares that pay cash each year, in your name, outside super.\n\nEvery dividend is taxed at about 47%. Company tax credits help a bit. 47% is still a lot.\n\nYou get spending money along the way. The tax office takes a cut every year.",
      group: "taxable",
      allocation: alloc({ taxable_you_income: S }),
    },
    {
      id: "spouse-growth",
      label: "Growth shares, spouse's name",
      summary:
        "Same price-goes-up shares, but they live in your spouse's name.\n\nTax on dividends and on a sale is at their lower rate, about 32%, not yours at about 47%. This is the simple put-it-in-her-name move.\n\nFor tax, it's their money. You both need to be okay with that.",
      group: "taxable",
      allocation: alloc({ taxable_you_growth: 0, taxable_spouse_growth: S }),
    },
    {
      id: "spouse-income",
      label: "Dividend shares, spouse's name",
      summary:
        "Shares that pay cash each year, in your spouse's name.\n\nDividends are taxed at about 32% instead of 47%. That's the split that actually uses the lower tax bracket.\n\nSame catch. Legally it's theirs.",
      group: "taxable",
      allocation: alloc({ taxable_spouse_income: S }),
    },
    {
      id: "recycle-growth",
      label: "Debt recycle, growth",
      summary:
        "Two steps. Park the lump in the offset so the home loan costs less. Then borrow that same amount as a new investment loan and buy growth shares.\n\nYou still have debt, but some of the interest can come off your tax. If the shares grow more than the loan costs after tax, you win. If they don't, you don't.\n\nThis is the spicy option. Keep a clean paper trail.",
      group: "recycle",
      allocation: alloc({ debt_recycle_you_growth: S }),
    },
    {
      id: "recycle-income",
      label: "Debt recycle, income",
      summary:
        "Same two-step as debt recycle. Offset the lump, borrow it back, buy shares. This time the shares pay dividends.\n\nThe loan interest can come off your tax, and the dividends plus company tax credits show up each year to help pay it.\n\nStill a loan. Still a problem if the shares have a bad run.",
      group: "recycle",
      allocation: alloc({ debt_recycle_you_income: S }),
    },
  ];

  if (ccYou > 0) {
    const cap = Math.round(ccYou).toLocaleString("en-AU");
    presets.push({
      id: "cc-you-offset",
      label: "Tax-cut into your super, rest offset",
      summary: `Put as much as this year's super tax-cut allows, about $${cap}, into your super. Leftover cash sits in the offset.\n\nYou get a tax refund at your high rate. Super then takes 15% of what went in. Still a win on the way in.\n\nThat super is locked until you can retire.`,
      group: "super",
      allocation: alloc({ super_cc_you: Math.min(S, ccYou), offset: rest(S, Math.min(S, ccYou)) }),
    });
    presets.push({
      id: "cc-you-spouse-growth",
      label: "Your super tax-cut, rest in spouse shares",
      summary:
        "First, take the tax-cut into your super. That's the 47% save. Leftover buys growth shares in your spouse's name, where tax is about 32%.\n\nGrabs the best tax trick first, then invests the rest where the tax office takes a smaller bite.\n\nSome money is locked in super. The rest is theirs for tax purposes.",
      group: "mix",
      allocation: alloc({
        super_cc_you: Math.min(S, ccYou),
        taxable_spouse_growth: rest(S, Math.min(S, ccYou)),
      }),
    });
  }

  if (ccSpouse > 0) {
    presets.push({
      id: "cc-spouse-offset",
      label: "Tax-cut into spouse super, rest offset",
      summary:
        "Same put-some-in-super idea, but it goes into their super.\n\nTheir refund is smaller than yours. They only save about 32% on the way in. You save about 47%. Shown so you can see the gap.\n\nUsually worse than doing the tax-cut in your name.",
      group: "super",
      allocation: alloc({
        super_cc_spouse: Math.min(S, ccSpouse),
        offset: rest(S, Math.min(S, ccSpouse)),
      }),
    });
  }

  if (nccYou > 0) {
    const room = Math.round(nccYou).toLocaleString("en-AU");
    presets.push({
      id: "ncc-you",
      label: "After-tax into your super",
      summary: `Put after-tax money into your super, up to about $${room} if bring-forward is on.\n\nNo extra tax cut. Tax was already paid. Super then only taxes the growth at 15%, which is gentler than 47% outside.\n\nLocked until retirement. Fine if you won't need the cash.`,
      group: "super",
      allocation: alloc({
        super_ncc_you: Math.min(S, nccYou),
        offset: rest(S, Math.min(S, nccYou)),
      }),
    });
  }

  if (nccSpouse > 0) {
    presets.push({
      id: "ncc-spouse",
      label: "After-tax into spouse super",
      summary:
        "Same after-tax dump, into their super.\n\nTax on growth inside super is 15% either way. You are using their yearly limit, not getting their 30% tax rate. That 30% vs 45% trick only works on shares outside super.\n\nUseful if you want more in super than your own limit allows.",
      group: "super",
      allocation: alloc({
        super_ncc_spouse: Math.min(S, nccSpouse),
        offset: rest(S, Math.min(S, nccSpouse)),
      }),
    });
  }

  if (nccYou > 0 && nccSpouse > 0) {
    const a = Math.min(S, nccYou);
    const b = Math.min(rest(S, a), nccSpouse);
    if (b > 0) {
      presets.push({
        id: "ncc-both",
        label: "After-tax into both supers",
        summary:
          "Fill your after-tax super limit, then theirs.\n\nGets more of the lump into the 15% tax world. Two accounts, two locks.\n\nLeftover, if any, sits in the offset.",
        group: "super",
        allocation: alloc({
          super_ncc_you: a,
          super_ncc_spouse: b,
          offset: rest(S, a + b),
        }),
      });
    }
  }

  const mixCc = Math.min(S, ccYou);
  const mixNcc = Math.min(rest(S, mixCc), nccSpouse);
  if (mixCc > 0) {
    presets.push({
      id: "household-play",
      label: "Tax-cut, then spouse, then shares",
      summary:
        "Do the good tax tricks in order.\n\nTax-cut into your super first, the 47% save. Then leftover into their super after-tax if it fits. Anything still left buys shares in their name.\n\nA bit of everything. Some money will be locked.",
      group: "mix",
      allocation: alloc({
        super_cc_you: mixCc,
        super_ncc_spouse: mixNcc,
        taxable_spouse_growth: rest(S, mixCc + mixNcc),
      }),
    });
  }

  const rec = Math.min(S, ccYou);
  if (rec > 0) {
    presets.push({
      id: "cc-you-recycle",
      label: "Tax-cut into your super, leftover recycled",
      summary:
        `This is two piles, not one.\n\nAbout $${Math.round(rec).toLocaleString("en-AU")} goes into your super as a tax-cut contribution. You get a tax refund at your high rate. Super takes 15% on the way in. That bit is locked until retirement.\n\nWhatever is left of the lump is debt-recycled. It sits in the offset, you borrow the same amount as an investment loan in your name, and you buy growth shares in your name.\n\nThe split below has the exact dollars.`,
      group: "mix",
      allocation: alloc({
        super_cc_you: rec,
        debt_recycle_you_growth: rest(S, rec),
      }),
    });
  }

  return presets.filter((p) => Object.keys(p.allocation).length > 0);
}
