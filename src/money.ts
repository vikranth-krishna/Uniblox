// All money in the service is an integer number of cents. No floats anywhere.

export type Cents = number;

// Largest amount we accept for a single value. Keeps amount * percent
// comfortably inside Number.MAX_SAFE_INTEGER.
const MAX_CENTS = 10_000_000_000_00; // 10 billion dollars

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) {
    throw new RangeError(`${label} must be an integer number of cents between 0 and ${MAX_CENTS}`);
  }
}

// Percentage discount on an amount, rounded down to the cent.
// Rounding down means the store never gives away a fraction of a cent it
// did not intend to, and the result can never exceed the amount itself.
export function percentOf(amount: Cents, percent: number): Cents {
  assertCents(amount, "amount");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError("percent must be an integer between 0 and 100");
  }
  return Math.floor((amount * percent) / 100);
}

export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole}.${frac}`;
}
