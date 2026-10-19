import { useState } from 'react';
import type { Address } from 'viem';
import { ADDR, PERMIT2, ROUTER } from './config';
import { erc20Abi, executorAbi, permit2Abi, routerAbi } from './abi';
import { publicClient } from './data';
import { formatTokens, formatUsdc } from './format';
import { buildSwapInputs } from './trade';
import type { Holding } from './useHoldings';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;
type Step = 'idle' | 'allow' | 'permit' | 'sell' | 'done' | 'error';

function friendly(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string };
  const msg = any?.shortMessage ?? any?.message ?? 'Something went wrong';
  if (/insufficient funds|gas/i.test(msg)) return 'Not enough test HYPE for gas. Add a little from the faucet.';
  if (/rejected|denied/i.test(msg)) return 'The request was cancelled.';
  return msg.slice(0, 220);
}

export function SellModal({ h, w, onClose, onDone }: { h: Holding; w: Wallet; onClose: () => void; onDone: () => void }) {
  const [pct, setPct] = useState(100);
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<bigint | null>(null);

  const amount = (h.balance * BigInt(pct)) / 100n;
  const estimate = h.priceUsd === null ? null : h.priceUsd * (Number(amount / 10n ** 12n) / 1e6);
  const busy = step === 'allow' || step === 'permit' || step === 'sell';

  async function run() {
    setError(null);
    try {
      const me = w.address as Address;
      const client = await w.getWalletClient();

      const [key] = await publicClient.readContract({
        address: ADDR.executor,
        abi: executorAbi,
        functionName: 'poolFor',
        args: [h.token],
      });
      const zeroForOne = key.currency0.toLowerCase() === h.token.toLowerCase();
      const tokenOut = (zeroForOne ? key.currency1 : key.currency0) as Address;

      // least we accept: 85% of what the spot price implies
      const [spotValue] = await publicClient.readContract({
        address: ADDR.executor,
        abi: executorAbi,
        functionName: 'previewValue',
        args: [h.token, amount],
      });
      const minOut = (spotValue * 85n) / 100n;

      const usdcBefore = await publicClient.readContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [me],
      });

      // 1. let Permit2 move these tokens
      const allowed = await publicClient.readContract({
        address: h.token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [me, PERMIT2],
      });
      if (allowed < amount) {
        setStep('allow');
        const tx = await client.writeContract({
          address: h.token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [PERMIT2, amount],
          gas: 120_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }

      // 2. let the router pull them through Permit2, for one hour
      const block = await publicClient.getBlock();
      setStep('permit');
      const tx2 = await client.writeContract({
        address: PERMIT2,
        abi: permit2Abi,
        functionName: 'approve',
        args: [h.token, ROUTER, amount, Number(block.timestamp) + 3600],
        gas: 120_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: tx2 });

      // 3. sell
      setStep('sell');
      const inputs = buildSwapInputs({ key, zeroForOne, tokenIn: h.token, tokenOut, amountIn: amount, minOut, recipient: me });
      const tx3 = await client.writeContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: 'execute',
        args: ['0x10', inputs, BigInt(Number(block.timestamp) + 600)],
        gas: 900_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx3 });
      if (receipt.status !== 'success') throw new Error('The sell did not go through. The price may have moved. Try again.');

      const usdcAfter = await publicClient.readContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [me],
      });
      setReceived(usdcAfter - usdcBefore);
      setStep('done');
      onDone();
    } catch (e) {
      setError(friendly(e));
      setStep('error');
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Sell {h.symbol}</h3>
          <button className="btn btn-ghost btn-small" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {step === 'done' ? (
          <div className="done">
            <p className="ok-text">Sold. You received {received !== null ? formatUsdc(received) : ''} USDC.</p>
            <p className="muted small">
              If this token had a protection, open “My protections” and cancel it, since you no longer hold the tokens.
            </p>
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="muted small">You hold {formatTokens(h.balance)} {h.symbol}</div>
            <label className="label">How much to sell</label>
            <div className="pcts">
              {[25, 50, 75, 100].map((p) => (
                <button key={p} className={pct === p ? 'tab on' : 'tab'} disabled={busy} onClick={() => setPct(p)}>
                  {p}%
                </button>
              ))}
            </div>
            <p>
              Selling {formatTokens(amount)} {h.symbol}
              {estimate !== null && (
                <>
                  {' '}
                  for about <b>{estimate.toFixed(2)} USDC</b>
                </>
              )}
              .
            </p>
            <p className="muted small">
              The USDC goes straight to your wallet. The sell is cancelled if the price moves more than 15% against you.
            </p>

            {busy && (
              <ol className="steps">
                <li className={step === 'allow' ? 'now' : 'past'}>Allow the tokens</li>
                <li className={step === 'permit' ? 'now' : step === 'sell' ? 'past' : ''}>Allow the router</li>
                <li className={step === 'sell' ? 'now' : ''}>Sell</li>
              </ol>
            )}
            {error && <p className="error">{error}</p>}
            <button className="btn btn-block" disabled={busy || amount === 0n} onClick={run}>
              {busy ? 'Working…' : 'Sell now'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
