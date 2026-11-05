// Pure decision logic for the Ripcord keeper. No network access here, so it can be unit-tested.
//
// status: what the executor's checkOrder(id) returned
//   { active, stopHit, creatorTripped, armedReady, holdersTripped }
// ctx: timing information kept by the keeper
//   { nowMs, lastArmMs, armCooldownMs }

export function decideAction(status, ctx) {
  if (!status.active) return { action: 'remove' };

  // Balance-based guards are hard facts on chain, so they execute immediately (no confirm delay).
  if (status.creatorTripped) return { action: 'execute', trigger: 'creator' };
  if (status.holdersTripped) return { action: 'execute', trigger: 'holders' };

  // Stop-loss needs arm -> wait CONFIRM_DELAY on chain -> execute.
  if (status.stopHit) {
    if (status.armedReady) return { action: 'execute', trigger: 'stop' };
    if (ctx.nowMs - ctx.lastArmMs >= ctx.armCooldownMs) return { action: 'arm', trigger: 'stop' };
    return { action: 'wait' };
  }

  return { action: 'wait' };
}

// After a failed attempt, wait before trying the same order again.
export function backoffElapsed(nowMs, lastFailMs, retryMs) {
  return nowMs - lastFailMs >= retryMs;
}

// ------------------------------------------------------------------ failure classification
// Decoded custom-error names come from the executor contract. Only these two mean the
// order itself cannot execute; everything else (unknown errors, RPC failures, lost
// races) is transient and must never escalate.

const UNFILLABLE_ERRORS = new Set(['NothingToSell', 'SlippageExceeded']);

// Pulls a decoded custom-error name out of a viem failure, wherever viem nested it.
// Returns null when there is no decoded name (RPC errors, timeouts, unknown shapes).
export function extractErrorName(err, depth = 0) {
  if (!err || typeof err !== 'object' || depth > 4) return null;
  if (typeof err.errorName === 'string') return err.errorName;
  if (err.data && typeof err.data.errorName === 'string') return err.data.errorName;
  return extractErrorName(err.cause, depth + 1);
}

// 'unfillable' only on a positively recognized error name, else 'transient'.
// A failed or inconclusive diagnosis must never escalate: unknown means transient.
export function classifyFailure(errorName) {
  return typeof errorName === 'string' && UNFILLABLE_ERRORS.has(errorName) ? 'unfillable' : 'transient';
}

// ------------------------------------------------------------------ backoff tiers
// Transient/unknown failures keep the historical 15 s retry. Diagnosed unfillable
// failures stay at 15 s for the first two consecutive diagnoses, then escalate to
// 5 minutes and cap at 1 hour. The consecutive count resets only on proof of
// executability (a passing simulation) or a successful send.

export const TRANSIENT_BACKOFF_MS = 15_000;
const UNFILLABLE_FIRST_MS = 15_000;
const UNFILLABLE_ESCALATED_MS = 300_000;
const UNFILLABLE_MAX_MS = 3_600_000;

// streak: consecutive unfillable diagnoses including the current one (>= 1).
export function unfillableBackoffMs(streak) {
  if (streak >= 4) return UNFILLABLE_MAX_MS;
  if (streak === 3) return UNFILLABLE_ESCALATED_MS;
  return UNFILLABLE_FIRST_MS;
}

// Next send-failure state for an order. A transient failure keeps the 15 s backoff
// but preserves the unfillable streak: only proof of executability resets it, so a
// transient blip cannot launder a persistently dead order back to fast retries.
export function recordFailure(streak, classification) {
  if (classification !== 'unfillable') {
    return { streak, backoffMs: TRANSIENT_BACKOFF_MS, lastClass: 'transient', simGate: true };
  }
  const n = streak + 1;
  return { streak: n, backoffMs: unfillableBackoffMs(n), lastClass: 'unfillable', simGate: true };
}

// Cleared state after proof of executability (a passing simulation or a sent receipt).
export function clearedSendState() {
  return { streak: 0, backoffMs: 0, lastClass: null, simGate: false };
}

// checkOrder read failures back off separately from sends: 2 s, doubling to 1 minute.
// Reads are cheap, so this only stops log/RPC storms during outages.
const READ_BACKOFF_FIRST_MS = 2_000;
const READ_BACKOFF_MAX_MS = 60_000;

export function readBackoffMs(currentMs) {
  if (!currentMs || currentMs <= 0) return READ_BACKOFF_FIRST_MS;
  return Math.min(currentMs * 2, READ_BACKOFF_MAX_MS);
}

// Gate predicates over disjoint per-order state. The send gate must never block the
// read: a backed-off order is still re-read every poll so cancellation, expiry, or
// execution is noticed immediately and the order can be dropped.
export function sendGated(nowMs, lastFailMs, sendBackoffMs) {
  return !backoffElapsed(nowMs, lastFailMs, sendBackoffMs);
}

export function readGated(nowMs, lastReadFailMs, readBackoff) {
  return !backoffElapsed(nowMs, lastReadFailMs, readBackoff);
}
