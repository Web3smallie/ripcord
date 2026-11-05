import type { Address } from 'viem';

/** Matches MAX_WATCH in RipcordExecutor.sol. */
export const MAX_WATCH = 50;

/**
 * Sort ascending and drop duplicates (case-insensitive). The contract requires
 * strictly ascending, non-zero addresses; lowercase hex order equals numeric order.
 */
export function sortWatchlist(addrs: Address[]): Address[] {
  const seen = new Set<string>();
  const uniq: Address[] = [];
  for (const a of addrs) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }
  return uniq.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * UI-side validation mirroring the contract's watchlist rules. Returns problem
 * strings, [] when submittable. Excluding contract addresses is enforced where
 * the chain flags exist (holder selection); the contract reverts as backstop.
 */
export function validateWatchlist(addrs: Address[], buyer: string | null): string[] {
  const problems: string[] = [];
  const lowered = addrs.map((a) => a.toLowerCase());
  if (lowered.length === 0) problems.push('Select at least one wallet to watch, or turn the holders rule off.');
  if (lowered.length > MAX_WATCH) problems.push(`Watch at most ${MAX_WATCH} wallets.`);
  if (new Set(lowered).size !== lowered.length) problems.push('Remove duplicate wallets.');
  if (lowered.includes(ZERO)) problems.push('The zero address cannot be watched.');
  if (buyer && lowered.includes(buyer.toLowerCase())) problems.push('Your own wallet cannot be watched.');
  return problems;
}

export type WatchPreset = { token: Address; addrs: Address[] } | null;

/**
 * Returns the preset addresses only when they belong to this token, [] otherwise.
 * A selection made for one token must never leak into another token's buy flow.
 */
export function presetForToken(preset: WatchPreset, token: string): Address[] {
  return preset && preset.token.toLowerCase() === token.toLowerCase() ? preset.addrs : [];
}
