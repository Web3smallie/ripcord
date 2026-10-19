import { useEffect, useState } from 'react';
import { ADDR, FAUCET_URL, explorerAddress } from './config';
import { formatPrice, formatUsd, shortAddr } from './format';
import { useTokens, type TokenRow } from './useTokens';
import { useBalances, useWallet } from './wallet';
import { BuyModal } from './BuyModal';
import { ProtectionsPanel } from './ProtectionsPanel';
import { WalletPanel } from './WalletPanel';
import { useHoldings } from './useHoldings';

type WalletState = ReturnType<typeof useWallet>;

function WalletButton({ w, usdc }: { w: WalletState; usdc: number | null }) {
  const [copied, setCopied] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!w.settingUp) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [w.settingUp]);

  if (!w.ready) {
    return (
      <button className="btn" disabled>
        Loading…
      </button>
    );
  }

  if (!w.authenticated) {
    return (
      <button className="btn" onClick={w.login}>
        Log in
      </button>
    );
  }

  if (w.settingUp) {
    return (
      <div className="wallet">
        <span className="pill">Creating your wallet…</span>
        {slow && (
          <button className="btn btn-small" onClick={w.createWalletNow}>
            Try again
          </button>
        )}
        <button className="btn btn-ghost btn-small" onClick={w.logout}>
          Log out
        </button>
      </div>
    );
  }

  if (w.address && !w.onElysium) {
    return (
      <div className="wallet">
        <button className="btn btn-warn" onClick={w.switchToElysium}>
          Switch to Elysium Testnet
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <span className="pill pill-ok">Elysium Testnet</span>
      <span className="pill" title="Test USDC">
        {usdc === null ? '… USDC' : `${usdc.toFixed(2)} USDC`}
      </span>
      <button
        className="btn btn-ghost"
        title="Copy your wallet address"
        onClick={() => {
          if (w.address) void navigator.clipboard.writeText(w.address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : w.address ? shortAddr(w.address) : ''}
      </button>
      <button className="btn btn-ghost" onClick={w.logout}>
        Log out
      </button>
    </div>
  );
}

function TokenCard({ t, onBuy }: { t: TokenRow; onBuy: (t: TokenRow) => void }) {
  return (
    <div className="card token">
      <div className="token-head">
        <div className="token-name">
          <div className="symbol">{t.symbol ?? shortAddr(t.token)}</div>
          <div className="muted clamp">{t.name ?? 'Loading name…'}</div>
          {t.sameNameCount > 1 && <div className="dupe">{t.sameNameCount} tokens share this name</div>}
        </div>
        <div className="right">
          <div className="price">{formatPrice(t.priceUsd)}</div>
          <div className="muted">mcap {formatUsd(t.marketCapUsd)}</div>
        </div>
      </div>
      <div className="token-meta">
        <a className="muted link" href={explorerAddress(t.token)} target="_blank" rel="noreferrer">
          {shortAddr(t.token)}
        </a>
        <span className="muted">creator {shortAddr(t.creator)}</span>
      </div>
      <button className="btn btn-block" onClick={() => onBuy(t)}>
        Buy &amp; Protect
      </button>
    </div>
  );
}

export function App() {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'tokens' | 'mine' | 'wallet'>('tokens');
  const [buying, setBuying] = useState<TokenRow | null>(null);
  const { launches, rows, total, loading, notice, lookup, canShowMore, showMore } = useTokens(query);
  const w = useWallet();
  const { hype, usdc } = useBalances(w.address);
  const holdingsState = useHoldings(w.address, launches.map((l) => l.token), tab === 'wallet');
  const lowGas = w.authenticated && w.address && hype !== null && hype < 0.001;

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo">⛓</span> Ripcord
        </div>
        <WalletButton w={w} usdc={usdc} />
      </header>

      {lowGas && (
        <div className="banner">
          Your wallet needs a little test HYPE for gas. Tap your address to copy it, then paste it into the{' '}
          <a className="link" href={FAUCET_URL} target="_blank" rel="noreferrer">
            Elysium faucet
          </a>
          .
        </div>
      )}
      {w.error && <div className="banner banner-bad">{w.error}</div>}

      <section className="hero">
        <h1>The market moves. Ripcord moves faster.</h1>
        <p className="lead">
          Set your exit conditions. Ripcord monitors on-chain activity and price movements, triggering automatic sells when your
          rules are met.
        </p>
        <p className="muted small">
          Elysium testnet · unaudited · executor{' '}
          <a className="link" href={explorerAddress(ADDR.executor)} target="_blank" rel="noreferrer">
            {shortAddr(ADDR.executor)}
          </a>
        </p>
      </section>

      <div className="tabs">
        <button className={tab === 'tokens' ? 'tab on' : 'tab'} onClick={() => setTab('tokens')}>
          Tokens
        </button>
        <button className={tab === 'mine' ? 'tab on' : 'tab'} onClick={() => setTab('mine')}>
          My protections
        </button>
        <button className={tab === 'wallet' ? 'tab on' : 'tab'} onClick={() => setTab('wallet')}>
          Wallet
        </button>
      </div>

      {tab === 'mine' && (
        <section>
          <ProtectionsPanel w={w} />
        </section>
      )}

      {tab === 'wallet' && (
        <section>
          <WalletPanel
            w={w}
            hype={hype}
            usdc={usdc}
            holdings={holdingsState.holdings}
            loading={holdingsState.loading}
            refreshHoldings={holdingsState.refresh}
          />
        </section>
      )}

      {tab === 'tokens' && (
      <section>
        <input
          className="search"
          placeholder="Search by name or symbol, or paste a contract address (CA)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />

        <h2>
          Ascend tokens <span className="muted count">{total}</span>
        </h2>
        {notice && <p className="muted small">{notice}</p>}
        {loading && rows.length === 0 && <p className="muted">Reading launches from the chain…</p>}
        {lookup.status === 'loading' && <p className="muted">Looking up that address…</p>}
        {lookup.status === 'notfound' && <p className="warn">That address is not a token launched on Ascend.</p>}
        {query.trim() && rows.length === 0 && lookup.status === 'idle' && !loading && (
          <p className="muted">No tokens match “{query.trim()}”.</p>
        )}

        <div className="grid">
          {rows.map((t) => (
            <TokenCard
              key={t.token}
              t={t}
              onBuy={(tok) => {
                if (!w.authenticated) w.login();
                else setBuying(tok);
              }}
            />
          ))}
        </div>

        {canShowMore && (
          <div className="more">
            <button className="btn btn-ghost" onClick={showMore}>
              Show more
            </button>
          </div>
        )}
      </section>
      )}

      {buying && <BuyModal token={buying} w={w} usdc={usdc} hype={hype} onClose={() => setBuying(null)} />}
    </div>
  );
}
