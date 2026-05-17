'use client';

/**
 * ServerDockerStats — live `docker stats` panel for the server detail page (S3).
 *
 * Fires a GET against `/api/internal/servers/{id}/docker-stats` on mount and
 * renders the Name / CPU% / Mem / Mem% / Net IO returned by the SSH command.
 * The route runs the command via the mock SSH client (TEST_MODE=mock) in dev
 * and E2E so callers get deterministic canned data without a real VPS.
 *
 * Three render states:
 *   - loading: dimmed placeholders (avoids layout shift)
 *   - error  : red banner with the server's error.message + Tekrar Dene
 *   - ok     : five-cell stat grid + "veriler SSH üzerinden alındı" caption
 *
 * Why a client component (not a server component prop drill):
 *   docker stats is live data — staleness defeats the purpose. Running it
 *   inside the page's render() would block the panel on the SSH roundtrip;
 *   running it in a client effect lets the page paint immediately and the
 *   stats stream in ~50-100ms later (mock) or a few hundred ms (real SSH).
 */

import { useCallback, useEffect, useState } from 'react';

interface DockerStats {
  name: string;
  cpuPerc: string;
  memUsage: string;
  memPerc: string;
  netIO: string;
}

interface ApiSuccess {
  success: true;
  data: DockerStats & { raw: unknown };
}

interface ApiFailure {
  success: false;
  error: { code: string; message: string };
}

type ApiResponse = ApiSuccess | ApiFailure;

interface Props {
  serverId: string;
}

export function ServerDockerStats({ serverId }: Props) {
  const [data, setData] = useState<DockerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/servers/${serverId}/docker-stats`, {
        method: 'GET',
        cache: 'no-store',
      });
      const json = (await res.json()) as ApiResponse;
      if (!json.success) {
        setError(json.error.message);
        setData(null);
      } else {
        setData({
          name: json.data.name,
          cpuPerc: json.data.cpuPerc,
          memUsage: json.data.memUsage,
          memPerc: json.data.memPerc,
          netIO: json.data.netIO,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bağlantı hatası');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      data-testid="docker-stats-panel"
      className="bg-slate-800 rounded-lg p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-100">Docker Stats (SSH)</h2>
        <button
          type="button"
          onClick={() => {
            void load();
          }}
          disabled={loading}
          className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-slate-200"
        >
          {loading ? 'Yükleniyor...' : 'Yenile'}
        </button>
      </div>

      {loading && !data && !error && (
        <p
          className="text-sm text-slate-400 animate-pulse"
          data-testid="docker-stats-loading"
        >
          SSH üzerinden docker stats alınıyor...
        </p>
      )}

      {error && (
        <div
          className="bg-red-900/40 text-red-300 p-3 rounded text-sm"
          data-testid="docker-stats-error"
        >
          {error}
        </div>
      )}

      {data && !error && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <Stat label="Container" value={data.name} testid="docker-stats-name" />
          <Stat label="CPU" value={data.cpuPerc} testid="docker-stats-cpu" />
          <Stat
            label="Bellek"
            value={data.memUsage}
            testid="docker-stats-mem-usage"
          />
          <Stat
            label="Bellek %"
            value={data.memPerc}
            testid="docker-stats-mem-perc"
          />
          <Stat label="Net I/O" value={data.netIO} testid="docker-stats-netio" />
        </div>
      )}

      <p className="text-xs text-slate-500 mt-3">
        Veriler SSH üzerinden <span className="font-mono">docker stats</span>{' '}
        komutu ile alındı.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}) {
  return (
    <div className="bg-slate-900/50 rounded p-2">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm text-slate-100 font-mono tabular-nums" data-testid={testid}>
        {value || '—'}
      </p>
    </div>
  );
}
