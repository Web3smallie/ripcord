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
