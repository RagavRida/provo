import { Routes, Route } from "react-router-dom";
import { Header } from "./components/Header";
import { Marketplace } from "./pages/Marketplace";
import { BuyerFlow } from "./pages/BuyerFlow";
import { ProviderFlow } from "./pages/ProviderFlow";
import { AgentDashboard } from "./pages/AgentDashboard";
import { useWallet } from "./lib/useWallet";
import { CONTRACT_ADDRESS } from "./lib/contract";

export default function App() {
  const { address, connecting, error, connect, publicClient, walletClient } = useWallet();

  const notDeployed = CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000";

  return (
    <div className="min-h-screen bg-provo-bg">
      <Header address={address} connecting={connecting} onConnect={connect} />

      {notDeployed && (
        <div className="mx-auto mt-4 max-w-6xl px-6">
          <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
            No contract address configured. Set VITE_CONTRACT_ADDRESS in web/.env after deploying ProvoMarketplace.
          </div>
        </div>
      )}

      {error && (
        <div className="mx-auto mt-4 max-w-6xl px-6">
          <div className="rounded-lg border border-provo-fail/40 bg-provo-fail/10 px-4 py-3 text-sm text-provo-fail">
            {error}
          </div>
        </div>
      )}

      <Routes>
        <Route path="/" element={<Marketplace publicClient={publicClient} />} />
        <Route
          path="/buy"
          element={<BuyerFlow address={address} publicClient={publicClient} walletClient={walletClient} onConnect={connect} />}
        />
        <Route
          path="/provide"
          element={<ProviderFlow address={address} publicClient={publicClient} walletClient={walletClient} onConnect={connect} />}
        />
        <Route path="/agent" element={<AgentDashboard />} />
      </Routes>

      <footer className="mx-auto max-w-6xl px-6 py-10 text-center text-xs text-provo-muted">
        Provo — a GPU costs what it delivers, not what it claims.
      </footer>
    </div>
  );
}
