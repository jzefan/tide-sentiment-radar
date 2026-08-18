import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useWatchlist() {
  const [codes, setCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      setCodes((await api.watchlist()).codes);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取自选股");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const toggle = useCallback(async (code: string) => {
    const selected = codes.includes(code);
    setCodes((current) => selected ? current.filter((item) => item !== code) : [...current, code]);
    try {
      const result = selected ? await api.removeWatchlist(code) : await api.addWatchlist(code);
      setCodes(result.codes);
      window.dispatchEvent(new CustomEvent("watchlist-updated", { detail: result.codes }));
    } catch (cause) {
      await reload();
      throw cause;
    }
  }, [codes, reload]);

  return { codes, loading, error, toggle, reload, has: (code: string) => codes.includes(code) };
}
