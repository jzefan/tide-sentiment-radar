import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RadarPage } from "./pages/RadarPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StockPage } from "./pages/StockPage";
import { WatchlistPage } from "./pages/WatchlistPage";

// Keep the large screener/daily-focus audit UI out of the initial radar bundle.
const ScreenerPage = lazy(async () => ({ default: (await import("./pages/ScreenerPage")).ScreenerPage }));

export default function App() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<RadarPage />} />
        <Route path="screener" element={<Suspense fallback={null}><ScreenerPage /></Suspense>} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="stocks/:code" element={<StockPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
