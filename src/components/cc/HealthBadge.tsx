/**
 * HealthBadge — server health status pill (Phase H9+).
 *
 * Combines `servers.last_health_status` and `servers.status` into a single
 * visual signal. Server `status` overrides health when the operator has
 * manually marked the host as maintenance / decommissioned / error.
 *
 * Output shape: dot-icon + Turkish label.
 *   - healthy        ● Sağlıklı (emerald)
 *   - degraded       ⚠ Düşük    (amber)
 *   - critical / error ⛔ Kritik (red)
 *   - maintenance    ⚠ Bakım    (amber)
 *   - decommissioned ⛔ Devre Dışı (red)
 *   - null           ○ Bilinmiyor (slate)
 */

export type ServerHealth = 'healthy' | 'degraded' | 'critical' | null;
export type ServerStatus =
  | 'active'
  | 'maintenance'
  | 'decommissioned'
  | 'error';

export function HealthBadge({
  health,
  status,
}: {
  health: ServerHealth;
  status: ServerStatus;
}) {
  if (status === 'maintenance') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <span aria-hidden="true">⚠</span>
        <span className="text-xs">Bakım</span>
      </span>
    );
  }
  if (status === 'decommissioned' || status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-red-300">
        <span aria-hidden="true">⛔</span>
        <span className="text-xs">
          {status === 'decommissioned' ? 'Devre Dışı' : 'Hata'}
        </span>
      </span>
    );
  }
  if (health === 'critical') {
    return (
      <span className="inline-flex items-center gap-1 text-red-300">
        <span aria-hidden="true">⛔</span>
        <span className="text-xs">Kritik</span>
      </span>
    );
  }
  if (health === 'degraded') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <span aria-hidden="true">⚠</span>
        <span className="text-xs">Düşük</span>
      </span>
    );
  }
  if (health === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-300">
        <span aria-hidden="true">●</span>
        <span className="text-xs">Sağlıklı</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-slate-400">
      <span aria-hidden="true">○</span>
      <span className="text-xs">Bilinmiyor</span>
    </span>
  );
}
