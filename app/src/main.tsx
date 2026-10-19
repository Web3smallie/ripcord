import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { App } from './App';
import { PRIVY_APP_ID, elysiumTestnet } from './config';
import './styles.css';

function Root() {
  if (!PRIVY_APP_ID) {
    return (
      <div className="page">
        <div className="card setup">
          <h2>One setup step left</h2>
          <p>
            Create a free app at <b>dashboard.privy.io</b>, copy its <b>App ID</b>, and put it in a file named <code>.env</code> in
            this folder as <code>VITE_PRIVY_APP_ID=your-app-id</code>. Then restart <code>npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email', 'google', 'wallet'],
        appearance: { theme: 'dark', accentColor: '#5b8cff' },
        defaultChain: elysiumTestnet,
        supportedChains: [elysiumTestnet],
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' }, // the app creates the wallet itself right after login
          showWalletUIs: false, // sign silently inside the app, no extra popups
        },
      }}
    >
      <App />
    </PrivyProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
