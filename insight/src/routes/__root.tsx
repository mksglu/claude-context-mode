import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { Database, Brain, History, Search, Building2 } from "lucide-react";

import "../styles.css";

const NAV = [
  { to: "/", label: "Dashboard", icon: Database },
  { to: "/knowledge", label: "Knowledge Base", icon: Brain },
  { to: "/sessions", label: "Sessions", icon: History },
  { to: "/search", label: "Search", icon: Search },
  { to: "/enterprise", label: "Enterprise", icon: Building2 },
] as const;

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="dark flex min-h-screen bg-background text-foreground">
      <aside className="w-56 border-r border-border bg-card fixed h-screen flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-sm font-semibold text-foreground tracking-wider uppercase">
            Context Mode
          </h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">
            Insight
          </p>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors border-l-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50 [&.active]:border-primary [&.active]:text-primary [&.active]:bg-accent [&.active]:font-medium"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground/50">
            Local · Read-only
          </p>
        </div>
      </aside>

      <main className="ml-56 flex-1 p-8 max-w-6xl">
        <Outlet />
      </main>
    </div>
  );
}
