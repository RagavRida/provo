import { NavLink } from "react-router-dom";
import { Logo } from "./Logo";
import { shortenAddress } from "../lib/format";

const navLinkClass = ({ isActive }) =>
  `text-sm font-medium transition-colors ${isActive ? "text-provo-text" : "text-provo-muted hover:text-provo-text"}`;

export function Header({ address, connecting, onConnect }) {
  return (
    <header className="border-b border-provo-border">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-8">
          <NavLink to="/" className="flex items-center gap-2">
            <Logo />
            <span className="text-lg font-semibold tracking-tight">Provo</span>
          </NavLink>
          <nav className="flex items-center gap-6">
            <NavLink to="/" end className={navLinkClass}>
              Marketplace
            </NavLink>
            <NavLink to="/buy" className={navLinkClass}>
              Buy Compute
            </NavLink>
            <NavLink to="/provide" className={navLinkClass}>
              Provide Compute
            </NavLink>
            <NavLink to="/agent" className={navLinkClass}>
              Agent
            </NavLink>
          </nav>
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="rounded-lg border border-provo-border bg-provo-surface px-4 py-2 text-sm font-medium text-provo-text transition-colors hover:border-provo-pass/60 disabled:opacity-60"
        >
          {address ? shortenAddress(address) : connecting ? "Connecting…" : "Connect Wallet"}
        </button>
      </div>
    </header>
  );
}
