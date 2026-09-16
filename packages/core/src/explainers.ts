export type Explainer = {
  id: string;
  title: string;
  body: string;
};

export const EXPLAINERS: Explainer[] = [
  {
    id: "super-split",
    title: "Super splitting vs putting money in her name",
    body: "Contribution splitting moves up to 85% of last year's concessional contributions into your spouse's super. It does not cut your 45% income tax. The 15% contributions tax is already paid. Use it to even up balances. Two transfer-balance caps, two preservation clocks. It is not a 45% to 30% tax cut.\n\nSpouse contributions are after-tax money into her fund. The spouse contribution tax offset only bites if her income is low, and it phases out by $40k. At a 30% bracket it does nothing.\n\nThe split that actually works is holding taxable investments in her name, so dividends and CGT land at 32% instead of 47%. Inside super, earnings are 15% in either fund. Fill concessional room in your name. The deduction is worth about 47c in the dollar vs about 32c for her.",
  },
  {
    id: "inside-outside",
    title: "Inside super vs outside",
    body: "A concessional contribution gives you a deduction at your marginal rate. The fund withholds 15%, plus Division 293 extra 15% on the slice of concessional once income plus concessional exceeds $250k. For a 47% taxpayer that's still a win on the way in, then 15% on earnings.\n\nA non-concessional contribution has no deduction and no 15% in. Useful when the concessional cap is full. Bring-forward in FY2026-27 can take up to $390k per person if total super is under $1.84m.\n\nOutside super you can sell. There is no preservation. Yield is taxed at 32% or 47%, and CGT after 1 Jul 2027 is indexed with a 30% floor. At 47% you still pay 47% on the real gain. Super wins on tax drag. Outside wins on access, and on using the lower-earning spouse's bracket.",
  },
  {
    id: "offset-recycle",
    title: "Offset, extra repayments, debt recycling",
    body: "Offset and extra repayments save the same interest, dollar for dollar. Offset stays spendable. That's why it's the usual first step before recycling.\n\nDebt recycling means put the lump on the offset, or pay down, then borrow a separate investment loan and buy assets. Home-loan interest on the remaining owner-occupier portion stays non-deductible. Interest on the investment loan is deductible. Day-one net wealth matches just investing the lump. The edge is the deduction plus keeping the offset working.\n\nBorrow in the 45% name. A deduction at 32% is worth less. Keep a paper trail so the ATO can see non-deductible debt being replaced by deductible debt. After 1 Jul 2027, negative gearing on most residential investment property is limited. Geared shares are not.",
  },
  {
    id: "cgt-2027",
    title: "1 July 2027 CGT",
    body: "From 1 Jul 2027 the 50% CGT discount is gone for individuals and trusts. Treasury Laws Amendment (Tax Reform No. 1) Act 2026 replaced it with CPI cost-base indexation and a 30% minimum tax on the real gain. Super funds are not on this regime.\n\nOn assets you already hold, gain accrued to 30 Jun 2027 can still get the 50% discount if you held for 12 months. Gain after that is indexed. Assets bought on or after 1 Jul 2027 are indexation only.\n\nAt 47% the 30% floor does not help you. You still pay 47% on the inflation-adjusted gain. At 32% the floor can lift the rate to 30% of the real gain. The old 50% discount at 32% was 16% of the whole gain. Waiting to sell is less of a trick than it was. High yield in the 47% name is still expensive.",
  },
  {
    id: "growth-income",
    title: "Growth vs dividend shares",
    body: "Growth shares, low yield, high capital. Tax mostly at the end as CGT. After 2027 that CGT is on real gains at the higher of your rate and 30%. Income shares, high yield. Tax every year at your rate. Franking credits help Australian equity.\n\nIn your name, high yield at 47% is a slog unless franking is fat. In her name, the same yield is taxed at 32% and franking can even refund. Inside super, both are about 15% on earnings, so the growth vs income split is about cashflow and risk, not tax.\n\nDebt-recycled income can pair deductible interest with franked yield, so the deduction shows up each year instead of waiting for a sale.",
  },
  {
    id: "other",
    title: "Things this ranking skips",
    body: "Insurance bonds. Life-company tax 30%, 10-year rule. Sometimes a middle path between taxable 47% and locked super. Rarely beats a 15% super earnings tax.\n\nA family trust is still on the 2027 CGT rules. Streaming to the 30% spouse is the same idea as holding shares in her name, with more paperwork.\n\nKeep an emergency buffer in the offset rather than in an extra repayment you cannot redraw.\n\nDownsizer contributions later, from 55, are a separate cap.\n\nDo not sell existing parcels just to reset for 2027 without running the numbers in Risu. The transitional 50% on gain to 30 Jun 2027 is usually worth keeping.",
  },
];
