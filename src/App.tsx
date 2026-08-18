import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RadarPage } from "./pages/RadarPage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StockPage } from "./pages/StockPage";
import { WatchlistPage } from "./pages/WatchlistPage";

export default function App() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<RadarPage />} />
        <Route path="screener" element={<ScreenerPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="stocks/:code" element={<StockPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
