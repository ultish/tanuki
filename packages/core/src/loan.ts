/** Monthly P&I payment for a principal over n years. */
export function pmt(principal: number, annualRate: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const r = annualRate / 12;
  const n = Math.round(years * 12);
  if (n <= 0) return 0;
  if (Math.abs(r) < 1e-12) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export type LoanStep = {
  interest: number;
  principalPaid: number;
  payment: number;
  balance: number;
  offset: number;
  interestBearing: number;
};

/**
 * One month of a home loan with an offset. Extra cash sitting in offset
 * above the balance still reduces interest to zero; surplus is just liquidity.
 */
export function stepHomeLoan(input: {
  balance: number;
  offset: number;
  annualRate: number;
  scheduledPayment: number;
  interestOnly: boolean;
}): LoanStep {
  const interestBearing = Math.max(0, input.balance - Math.max(0, input.offset));
  const interest = interestBearing * (input.annualRate / 12);
  if (input.balance <= 0) {
    return {
      interest: 0,
      principalPaid: 0,
      payment: 0,
      balance: 0,
      offset: input.offset,
      interestBearing: 0,
    };
  }
  if (input.interestOnly) {
    return {
      interest,
      principalPaid: 0,
      payment: interest,
      balance: input.balance,
      offset: input.offset,
      interestBearing,
    };
  }
  const payment = Math.min(input.scheduledPayment, input.balance + interest);
  const principalPaid = Math.min(input.balance, Math.max(0, payment - interest));
  return {
    interest,
    principalPaid,
    payment,
    balance: input.balance - principalPaid,
    offset: input.offset,
    interestBearing,
  };
}
