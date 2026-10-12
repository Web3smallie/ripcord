import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAction, backoffElapsed } from './decide.mjs';

const base = { active: true, stopHit: false, creatorTripped: false, armedReady: false, holdersTripped: false };
const ctx = (over = {}) => ({ nowMs: 100_000, lastArmMs: 0, armCooldownMs: 11_000, ...over });

test('inactive orders are dropped', () => {
  assert.deepEqual(decideAction({ ...base, active: false }, ctx()), { action: 'remove' });
});

test('nothing tripped means wait', () => {
  assert.deepEqual(decideAction(base, ctx()), { action: 'wait' });
});

test('creator guard executes immediately, no arming', () => {
  assert.deepEqual(decideAction({ ...base, creatorTripped: true }, ctx()), { action: 'execute', trigger: 'creator' });
});

test('holder watchlist executes immediately, no arming', () => {
  assert.deepEqual(decideAction({ ...base, holdersTripped: true }, ctx()), { action: 'execute', trigger: 'holders' });
});

test('creator guard wins over a stop that is also hit', () => {
  const s = { ...base, creatorTripped: true, stopHit: true, armedReady: true };
  assert.equal(decideAction(s, ctx()).trigger, 'creator');
});

test('stop hit but not armed: arm first', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx()), { action: 'arm', trigger: 'stop' });
});

test('stop hit, armed and confirmed: execute', () => {
  assert.deepEqual(
    decideAction({ ...base, stopHit: true, armedReady: true }, ctx()),
    { action: 'execute', trigger: 'stop' }
  );
});

test('stop hit, we armed a moment ago and it is not confirmed yet: wait', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx({ lastArmMs: 95_000 })), { action: 'wait' });
});

test('stop hit, our last arming has expired: arm again', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: true }, ctx({ lastArmMs: 80_000 })), { action: 'arm', trigger: 'stop' });
});

test('price recovered: wait, never execute', () => {
  assert.deepEqual(decideAction({ ...base, stopHit: false, armedReady: false }, ctx()), { action: 'wait' });
});

test('backoff', () => {
  assert.equal(backoffElapsed(10_000, 5_000, 30_000), false);
  assert.equal(backoffElapsed(40_000, 5_000, 30_000), true);
});
