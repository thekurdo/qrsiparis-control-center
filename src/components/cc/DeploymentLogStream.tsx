'use client';

/**
 * DeploymentLogStream — live SSE log streamer (Phase H8).
 *
 * Hydrates with the persisted `deployments.log` text fetched server-side,
 * then (when `isActive`) opens an EventSource against
 * `/api/internal/deployments/{id}/log-stream` and appends each incoming
 * line to the visible <pre>. Auto-scrolls to the bottom on every append
 * unless the operator has scrolled up — in that case we honour the
 * scrollback so they can read older entries without being yanked back.
 *
 * Download button: serialises the current buffer to a Blob and triggers
 * a `<a download>` click. We hand-roll this rather than relying on the
 * server endpoint because the in-memory buffer always contains the
 * freshest streamed lines (the DB column lags by one flushLogs() cycle).
 *
 * The stream is closed on:
 *   - component unmount (useEffect cleanup)
 *   - EventSource error event (browser auto-reconnects otherwise; we
 *     deliberately disable that to avoid leaking handles after the
 *     deploy finishes)
 */

import { useEffect, useRef, useState } from 'react';

interface DeploymentLogStreamProps {
  deploymentId: string;
  initialLog: string | null;
  /** Whether the deployment is still pending/in-progress and worth subscribing to. */
  isActive: boolean;
}

export function DeploymentLogStream({
  deploymentId,
  initialLog,
  isActive,
}: DeploymentLogStreamProps) {
  const [log, setLog] = useState<string>(initialLog ?? '');
  const [streamState, setStreamState] = useState<
    'idle' | 'connecting' | 'open' | 'closed' | 'error'
  >(isActive ? 'connecting' : 'idle');

  const preRef = useRef<HTMLPreElement>(null);
  // Track whether the operator has scrolled away from the bottom — when
  // they have, we stop auto-scrolling so we don't fight their reading.
  const stickyBottomRef = useRef<boolean>(true);

  useEffect(() => {
    if (!isActive) {
      setStreamState('idle');
      return;
    }
    setStreamState('connecting');
    const sse = new EventSource(
      `/api/internal/deployments/${deploymentId}/log-stream`,
    );

    sse.onopen = () => {
      setStreamState('open');
    };

    sse.onmessage = (e: MessageEvent<string>) => {
      setLog((prev) => {
        const sep = prev.length > 0 && !prev.endsWith('\n') ? '\n' : '';
        return `${prev}${sep}${e.data}\n`;
      });
      // Auto-scroll on next paint — only if the operator hasn't scrolled
      // away from the bottom.
      requestAnimationFrame(() => {
        const node = preRef.current;
        if (!node) return;
        if (stickyBottomRef.current) {
          node.scrollTop = node.scrollHeight;
        }
      });
    };

    sse.onerror = () => {
      setStreamState('error');
      // Disable browser auto-reconnect — once the pipeline finishes the
      // server closes the channel and reconnect attempts would 404 / spam.
      sse.close();
    };

    return () => {
      setStreamState('closed');
      sse.close();
    };
  }, [deploymentId, isActive]);

  function handleScroll() {
    const node = preRef.current;
    if (!node) return;
    const distance =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    // 40px threshold: small wiggle room for browsers that report
    // sub-pixel offsets after a programmatic scrollTop set.
    stickyBottomRef.current = distance < 40;
  }

  function handleDownload() {
    downloadLog(log, deploymentId);
  }

  return (
    <div className="bg-slate-900 rounded-lg overflow-hidden border border-slate-700">
      <div className="px-4 py-3 border-b border-slate-700 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h3 className="text-slate-200 font-semibold text-sm">Canlı Log</h3>
          <StreamStatusBadge state={streamState} />
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={log.length === 0}
          className="text-blue-400 text-sm hover:text-blue-300 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Logu İndir
        </button>
      </div>
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="p-4 text-xs font-mono text-slate-300 overflow-auto max-h-[500px] whitespace-pre-wrap"
      >
        {log.length > 0
          ? log
          : isActive
            ? 'Log akışı bekleniyor...'
            : '(Log boş)'}
      </pre>
    </div>
  );
}

function StreamStatusBadge({
  state,
}: {
  state: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
}) {
  const config = {
    idle: { cls: 'bg-slate-700 text-slate-400', label: 'Pasif' },
    connecting: { cls: 'bg-blue-900/40 text-blue-300', label: 'Bağlanıyor...' },
    open: { cls: 'bg-emerald-900/40 text-emerald-300', label: 'Canlı' },
    closed: { cls: 'bg-slate-700 text-slate-400', label: 'Kapalı' },
    error: { cls: 'bg-red-900/40 text-red-300', label: 'Bağlantı Hatası' },
  }[state];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium ${config.cls}`}
    >
      {config.label}
    </span>
  );
}

function downloadLog(log: string, id: string) {
  const blob = new Blob([log], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deployment-${id}.log.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke async — Safari otherwise sometimes cancels the download if the
  // URL is revoked synchronously inside the click handler.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
