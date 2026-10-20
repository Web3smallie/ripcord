***

# ⛓️ Ripcord

<p align="center">
  <strong>Your entry is a decision. Your exit should be one, too.</strong>
</p>

<p align="center">
  Automated, non-custodial downside protection for tokens launched on Elysium Ascend.<br/>
  Stop-loss, creator-dump defense, and whale-tracking execution in a single transaction.
</p>

# ⛓️ Ripcord

<p align="center">
  <strong>Your entry is a decision. Your exit should be one, too.</strong>
</p>

<p align="center">
  Automated, non-custodial downside protection for tokens launched on Elysium Ascend.
</p>

<p align="center">
  🌐 <strong>Live App:</strong>
  <a href="https://www.getripcord.xyz/">https://www.getripcord.xyz/</a>
</p>

<p align="center">
  <a href="https://www.getripcord.xyz/"><strong>🚀 LAUNCH RIPCORD APP</strong></a>
  ·
  <a href="https://github.com/Web3smallie/ripcord">GitHub Repository</a>
  ·
  <a href="https://ripcord-53y7.onrender.com/status">Keeper Status</a>
</p>

<p align="center">
  <a href="https://elysium.kinetiq.xyz/testnet-explorer">
    <img src="https://img.shields.io/badge/Network-Elysium%20Testnet%20(99801)-blue?style=flat-square" alt="Network: Elysium Testnet" />
  </a>
  <a href="https://book.getfoundry.sh/">
    <img src="https://img.shields.io/badge/Built%20with-Foundry-orange?style=flat-square" alt="Built with Foundry" />
  </a>
  <a href="https://ripcord-53y7.onrender.com/status">
    <img src="https://img.shields.io/badge/Keeper-Live%20on%20Render-green?style=flat-square" alt="Keeper Status" />
  </a>
  <img src="https://img.shields.io/badge/Custody-Non--Custodial-purple?style=flat-square" alt="Non-custodial design" />
</p>

---
---

## ⚡ The Problem

On bonding curves and launchpads, early tokens move in seconds:
- **The creator stealth-dumps** their allocation while you're away from your desk.
- **Top holders coordinate exits**, collapsing pool liquidity.
- **A flash cascade triggers**, leaving you holding 90% underwater bags.

Traditional price alerts tell you when you've already lost money. **Ripcord acts before the floor falls out.**

---

## 💡 What is Ripcord?

**Ripcord** is an automated risk-engine and non-custodial execution layer purpose-built for Ascend on the **Elysium Network**. 

Instead of parking tokens in a centralized smart contract, **you retain 100% custody in your wallet**. If your chosen exit condition is tripped, Ripcord's keeper network routes an exit transaction directly through Ascend’s UniversalRouter, swaps the token back to USDC, and deposits the proceeds straight into your wallet.

```
┌──────────────┐     Buy & Protect      ┌─────────────────────────┐
│ User Wallet  │ ─────────────────────► │ Tokens stay in WALLET   │
└──────────────┘                        └───────────┬─────────────┘
                                                    │
                                  Keeper watches on-chain triggers
                                  (Price Stop / Dev Dump / Whales)
                                                    │
                                                    ▼
┌──────────────┐   USDC proceeds sent   ┌─────────────────────────┐
│ User Wallet  │ ◄───────────────────── │ Ripcord Executor        │
└──────────────┘   (minus 0.30% fee)    │ • Pulls tokens on exit  │
                                        │ • Swaps via Ascend      │
                                        └─────────────────────────┘
```

---

## 🛡️ Three Defense Layers

| Protection | Trigger Condition | Anti-Manipulation Guard | Status |
| :--- | :--- | :--- | :--- |
| **📉 Price Stop** | Token price drops $X\%$ from your entry | **2-second confirmation delay** prevents single-block MEV/sandwich fakeouts | ✅ Live in App (1% – 90%) |
| **🚨 Creator Guard** | Token creator wallet balance drops by $X\%$ | **Instant execution** (balance drops are hard cryptographic facts) | ✅ Live in App (1% – 95%) |
| **🐋 Holder Watch** | Combined balance of up to 50 top holders drops below floor | Multi-wallet balance aggregation across EOAs | 🧪 Contract verified; UI in progress |

---

## 🎯 How It Works

1. **Discover & Select:** Browse newly launched Ascend tokens or search by contract address.
2. **Buy & Protect in 1 Click:** Specify your purchase amount in USDC and toggle your desired stop-loss or creator guard in the same modal.
3. **Keep Total Custody:** You hold the tokens. Ripcord is granted a standard ERC-20 approval that is only utilized if your trigger trips.
4. **Autonomous Monitoring:** Off-chain keepers monitor contract events, pool ticks, and creator balances in real-time.
5. **On-Chain Enforcement:** When a keeper submits an `execute()` call, the smart contract cryptographically validates the trigger against pool slot data and creator balances. **No exit can be faked or frontrun.**
6. **Instant Settlement:** Tokens are routed through Ascend’s UniversalRouter, and USDC is transferred immediately to your address.

---

## 📊 Transparent Economics

Ripcord aligns its incentives directly with your downside protection:

- **Free to Buy:** 0% Ripcord fee.
- **Free to Set Protection:** 0% setup or activation fee.
- **Free to Cancel:** Cancel or modify orders at any time without fees.
- **Performance-Only Exit Fee:** **0.30% (30 bps)** deducted *only* from net proceeds upon a successfully executed exit.

> **Example:** You invest 1,000 USDC. A creator dump triggers an exit, recovering 950 USDC. Ripcord deducts a 2.85 USDC fee (0.30%), and **947.15 USDC is returned directly to your wallet**. If you sell manually or hold to expiry, you pay **0 USDC**.

---

## 🧪 Proven Testnet Performance

Ripcord has undergone live integration testing against Ascend on Elysium Testnet:

- **Detection-to-Confirmation:** **3.18 seconds** (tested on public testnet RPC from a home node before fast-path optimizations).
- **Execution Gas:** **~0.00003 HYPE** per automated exit.
- **Fork Test Validation:** Full end-to-end simulation executing a creator-dump exit against real Ascend launch pools returning ~9.75 USDC on a 10 USDC test run (accounting for Ascend's AMM pool fee and Ripcord's 0.30% fee).

---

## 🔍 Verified Deployments (Elysium Testnet · 99801)

| Component | Contract Address | Explorer |
| :--- | :--- | :--- |
| **Ripcord Executor** | `0x484804031B174B67Efa9A380Dde948bd7627e8Fb` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x484804031B174B67Efa9A380Dde948bd7627e8Fb) |
| **Ascend Launchpad Hook** | `0x6d01f6644bbf1b5074472D3e85aa1465B4d2bF3d` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x6d01f6644bbf1b5074472D3e85aa1465B4d2bF3d) |
| **Ascend UniversalRouter** | `0x90332b0ecbb2c9517f405627b0dd5d5265246563` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x90332b0ecbb2c9517f405627b0dd5d5265246563) |
| **Pool Manager** | `0x12E84206cB53aE0df055482ebc4658635096E1aA` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x12E84206cB53aE0df055482ebc4658635096E1aA) |
| **Testnet USDC (Quote)** | `0x84Cc00D13173f7016Bbab22A736dBf75A154cFE2` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x84Cc00D13173f7016Bbab22A736dBf75A154cFE2) |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | [View on Explorer](https://elysium.kinetiq.xyz/testnet-explorer/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) |
| **Live Keeper Node** | `0x5bD831353a4de1Bfbd359074ad2b391FaE335c85` | [Live Status API](https://ripcord-53y7.onrender.com/status) |

---

## 🔐 Security Architecture

- **No Standing Custody:** User tokens are pulled via `transferFrom` only during the atomic execution transaction. The contract has no function that allows the owner or keepers to withdraw or touch idle user funds.
- **Immutable Bounds:** The maximum exit fee is hardcoded to a maximum ceiling of 1.00% (`feeBps <= 100`). The current deployed fee is permanently set to 0.30%.
- **Emergency Unpauseable Exits:** The contract owner can pause *new* protection creation, but **can never pause or block exits or cancellations**.
- **Reentrancy Protection:** All swap and exit routes are protected by non-reentrant guards and conform to CEI (Checks-Effects-Interactions) patterns.

---

## 💻 Developer Quickstart

### Prerequisites
- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`)
- Node.js 20+

### 1. Smart Contracts & Fork Tests
Run fork tests against live Elysium state:

```bash
# Clone repository
git clone https://github.com/Web3smallie/ripcord.git
cd ripcord

# Build contracts
forge build

# Run unit & live fork tests
forge test --match-path test/NewLaunchpad.t.sol --fork-url https://testnet-rpc.elysium.kinetiq.xyz -vv
forge test --match-path test/RipcordExecutor.t.sol --fork-url https://testnet-rpc.elysium.kinetiq.xyz -vv
```

### 2. Keeper Bot
```bash
cd keeper
npm install
cp .env.example .env

# Set KEEPER_PRIVATE_KEY and EXECUTOR=0x484804031B174B67Efa9A380Dde948bd7627e8Fb
npm start
```

### 3. Frontend Application
```bash
cd app
npm install
cp .env.example .env

# Set VITE_PRIVY_APP_ID from dashboard.privy.io
npm run dev
```

---

## 🗺️ Roadmap


- **Take-Profit & Partial Exits: Automatically secure profits at configurable price targets.
- **Portfolio Dashboard: Track holdings, profit/loss, and trading history.
- **Multi-Keeper Infrastructure: Improve monitoring availability and execution reliability.
- **Multi-Launchpad Support: Expand beyond Ascend after validating the core implementation.
- **Trailing Stop-Loss: Adjust exit thresholds as prices rise.
- **Social Login Integration:** Embedded wallets via Privy (X, Telegram, github).
- **Top Holder Watch UI:** Visual whale tracking modal and custom wallet list inputs.
- **Telegram bot.** First, exit alerts sent to your chat the moment a rule triggers. Then buying, selling and protecting from Telegram, built on non-custodial wallets so Ripcord never holds your keys.
- **Email Alerts:** Real-time push notifications when orders arm or execute.
- **Take-Profit Ladders:** Automated partial profit taking (e.g., sell 25% at 2x, 50% at 5x).
- **External Security Audit:** Third-party smart contract audit prior to Mainnet launch.

---

## 👤 Author

Built by **([@Web3smallie](https://github.com/Web3smallie))

*Built on Elysium. Powered by Ascend.*