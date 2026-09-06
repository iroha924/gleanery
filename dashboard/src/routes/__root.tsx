import { useQuery } from "@tanstack/react-query";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { api } from "../lib/api";

function Nav() {
  const { data } = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const link = "px-3 py-1.5 rounded-md text-sm hover:bg-black/5 dark:hover:bg-white/10";
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-5xl items-center gap-1 px-5 py-3">
        <Link to="/" className="mr-3 font-semibold tracking-tight">
          mitos
        </Link>
        <Link to="/" className={link} activeProps={{ className: `${link} bg-black/5 dark:bg-white/10` }}>
          検索
        </Link>
        <Link
          to="/records"
          className={link}
          activeProps={{ className: `${link} bg-black/5 dark:bg-white/10` }}
        >
          記録
        </Link>
        <Link
          to="/scopes"
          className={link}
          activeProps={{ className: `${link} bg-black/5 dark:bg-white/10` }}
        >
          作業場所
        </Link>
        {data && (
          <span className="ml-auto text-xs text-muted tabular-nums">
            {data.nodes} 件の判断 / {data.records} 記録 / {data.scopes} 場所
          </span>
        )}
      </div>
    </header>
  );
}

export const Route = createRootRoute({
  component: () => (
    <>
      <Nav />
      <main className="mx-auto max-w-5xl px-5 py-6">
        <Outlet />
      </main>
    </>
  ),
});
