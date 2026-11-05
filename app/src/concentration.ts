import type { RadarResult } from './radar';

export type OkRadar = Extract<RadarResult, { status: 'ok' }>;

/**
 * Provisional concentration thresholds, in percent of circulating supply.
 * These are NOT agreed product policy: the UI prints each value next to the
 * statement it triggers so they can be reviewed and approved.
 */
export const PROVISIONAL_THRESHOLDS = {
  /** Creator holds more than half of circulating supply. */
  creatorHighPct: 50,
  /** Top 5 wallets combined hold more than half of circulating supply. */
  top5HighPct: 50,
  /** Top 10 wallets combined hold more than three quarters. */
  top10HighPct: 75,
} as const;

export type HolderRank = {
  rank: number;
  address: string;
  balance: bigint;
  pctCirculating: number;
  isContract: boolean;
  isCreator: boolean;
};

export type ConcentrationNote = {
  key: 'creator-high' | 'creator-empty' | 'top5-high' | 'top10-high';
  /** False for purely informational notes (e.g. creator holds nothing). */
  breached: boolean;
  text: string;
  /** Methodology: the threshold and the measured value behind the statement. */
  detail: string;
};

export type DistributionSlice = {
  key: 'pool' | 'creator' | 'top' | 'further' | 'dust';
  label: string;
  balance: bigint;
  pctTotal: number;
};

export type Concentration = {
  ranked: HolderRank[];
  top5Pct: number;
  top10Pct: number;
  creatorPctCirculating: number | null;
  distribution: DistributionSlice[];
  notes: ConcentrationNote[];
  methodology: string;
};

function sumPct(rows: { pctCirculating: number }[]): number {
  return rows.reduce((s, r) => s + r.pctCirculating, 0);
}

/**
 * Derives rankings, distribution, and concentration notes from an
 * integrity-checked Radar result. Pure: no RPC, no clock, no guessing.
 * Callers must only pass `status: 'ok'` results — anything else has no
 * verified figures to analyze.
 */
export function summarizeConcentration(result: OkRadar): Concentration {
  const all = result.holders.map((h) => ({ ...h, isCreator: false }));
  if (result.creator) all.push({ ...result.creator, isCreator: true });
  all.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  const ranked: HolderRank[] = all.map((h, i) => ({
    rank: i + 1,
    address: h.address,
    balance: h.balance,
    pctCirculating: h.pctCirculating,
    isContract: h.isContract,
    isCreator: h.isCreator,
  }));
  const top5Pct = sumPct(ranked.slice(0, 5));
  const top10Pct = sumPct(ranked.slice(0, 10));
  const creatorPctCirculating = result.creator ? result.creator.pctCirculating : null;

  // circulating = creator + shown + other; other = hidden above-dust + dust.
  const shownSum = result.holders.reduce((s, h) => s + h.balance, 0n);
  const furtherBalance = result.otherBalance - result.dust.balance;
  const pctTotal = (b: bigint): number =>
    result.totalSupply === 0n ? 0 : (Number((b * 10_000_00n) / result.totalSupply) / 100).valueOf();
  const distribution: DistributionSlice[] = [
    { key: 'pool', label: 'Pool (unsold)', balance: result.poolBalance, pctTotal: result.poolPctTotal },
    {
      key: 'creator',
      label: 'Creator',
      balance: result.creator ? result.creator.balance : 0n,
      pctTotal: result.creator ? result.creator.pctTotal : 0,
    },
    { key: 'top', label: `Top holders shown (${result.holders.length})`, balance: shownSum, pctTotal: pctTotal(shownSum) },
    {
      key: 'further',
      label: `Further holders (${result.moreHolders})`,
      balance: furtherBalance,
      pctTotal: pctTotal(furtherBalance),
    },
    {
      key: 'dust',
      label: `Dust wallets (${result.dust.count})`,
      balance: result.dust.balance,
      pctTotal: pctTotal(result.dust.balance),
    },
  ];

  const t = PROVISIONAL_THRESHOLDS;
  const notes: ConcentrationNote[] = [];
  if (creatorPctCirculating === null) {
    notes.push({
      key: 'creator-empty',
      breached: false,
      text: 'The creator holds no tokens now.',
      detail: 'A creator guard would have nothing to watch.',
    });
  } else if (creatorPctCirculating > t.creatorHighPct) {
    notes.push({
      key: 'creator-high',
      breached: true,
      text: `The creator holds ${creatorPctCirculating.toFixed(1)}% of circulating supply.`,
      detail: `Provisional threshold: above ${t.creatorHighPct}%.`,
    });
  }
  if (top5Pct > t.top5HighPct) {
    notes.push({
      key: 'top5-high',
      breached: true,
      text: `The top 5 wallets hold ${top5Pct.toFixed(1)}% of circulating supply.`,
      detail: `Provisional threshold: above ${t.top5HighPct}%.`,
    });
  }
  if (top10Pct > t.top10HighPct) {
    notes.push({
      key: 'top10-high',
      breached: true,
      text: `The top 10 wallets hold ${top10Pct.toFixed(1)}% of circulating supply.`,
      detail: `Provisional threshold: above ${t.top10HighPct}%.`,
    });
  }

  return {
    ranked,
    top5Pct,
    top10Pct,
    creatorPctCirculating,
    distribution,
    notes,
    methodology:
      `Shares are of circulating supply (total minus pool-held) from chain-verified balances at block ${result.block}. ` +
      `Provisional thresholds: creator above ${t.creatorHighPct}%, top 5 above ${t.top5HighPct}%, top 10 above ${t.top10HighPct}%.`,
  };
}
