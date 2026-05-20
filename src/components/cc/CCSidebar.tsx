'use client';

/**
 * CCSidebar — vertical navigation rail for the operator panel (Phase H9+).
 *
 * 240px wide, slate-800 background, fixed to the left edge of the panel
 * shell. Active route is detected via `usePathname()` and highlighted.
 *
 * Items (in order):
 *   - Genel Durum   (/)
 *   - Müşteriler    (/musteriler)
 *   - Sunucular     (/sunucular)
 *   - Deployments   (/deployments)
 *   - Faturalama    (/faturalama)        — V1.5; "Yakında" badge
 *   - Sistem (collapsible group)
 *       - Cron      (/sistem/cron)
 *       - Audit Log (/sistem/audit)
 *       - Kullanıcılar (/sistem/kullanicilar)  — admin-only
 *       - Genel Ayarlar (/sistem/ayarlar)
 *   - Çıkış (POSTs to /api/internal/auth/signout)
 *
 * Role gating: operators see all items except Sistem→Kullanıcılar (admin
 * only). The Sistem group itself is still visible to operators since they
 * use Cron / Audit / Settings.
 */

import type { Route } from 'next';
import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import type { OperatorRole } from '@/lib/auth/middleware';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: string;
  /** If set, only roles in this list see the item. */
  roles?: OperatorRole[];
}

const PRIMARY: NavItem[] = [
  { href: '/', label: 'Genel Durum', icon: '🏠' },
  { href: '/musteriler', label: 'Müşteriler', icon: '👥' },
  { href: '/sunucular', label: 'Sunucular', icon: '🖥' },
  { href: '/deployments', label: 'Deployments', icon: '🚀' },
  { href: '/faturalama', label: 'Faturalama', icon: '💰', badge: 'Yakında' },
];

const SISTEM: NavItem[] = [
  { href: '/sistem/cron', label: 'Cron', icon: '⏰' },
  { href: '/sistem/audit', label: 'Audit Log', icon: '📜' },
  {
    href: '/sistem/kullanicilar',
    label: 'Kullanıcılar',
    icon: '👤',
    roles: ['admin'],
  },
  { href: '/sistem/ayarlar', label: 'Genel Ayarlar', icon: '⚙' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function CCSidebar({ role }: { role: OperatorRole }) {
  const pathname = usePathname();
  // Sistem group is open by default if the user is currently inside it.
  const [sistemOpen, setSistemOpen] = useState(
    () => pathname?.startsWith('/sistem') ?? false,
  );

  const visibleSistem = SISTEM.filter(
    (item) => !item.roles || item.roles.includes(role),
  );

  async function handleSignOut() {
    // signOut redirects to the URL we pass; the configured pages.signIn
    // route ('/login') is the natural landing page.
    await signOut({ callbackUrl: '/login' });
  }

  return (
    <aside className="w-60 shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col">
      {/* Brand */}
      <div className="h-14 px-4 flex items-center border-b border-slate-700">
        <span className="text-base font-semibold text-slate-100">
          QrSiparis CC
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
        {PRIMARY.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname ?? '', item.href)}
          />
        ))}

        {/* Sistem group */}
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setSistemOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-md text-slate-300 hover:bg-slate-700/50"
            aria-expanded={sistemOpen}
            aria-controls="cc-sidebar-sistem"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">📊</span>
              <span>Sistem</span>
            </span>
            <span
              aria-hidden="true"
              className={`text-xs transition-transform ${sistemOpen ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          </button>
          {sistemOpen && (
            <div id="cc-sidebar-sistem" className="mt-1 ml-4 space-y-1">
              {visibleSistem.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isActive(pathname ?? '', item.href)}
                />
              ))}
            </div>
          )}
        </div>
      </nav>

      {/* Sign out */}
      <div className="p-3 border-t border-slate-700">
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-700/50"
        >
          <span aria-hidden="true">🚪</span>
          <span>Çıkış</span>
        </button>
      </div>
    </aside>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href as Route}
      className={`flex items-center justify-between px-3 py-2 rounded-md transition-colors ${
        active
          ? 'bg-slate-700/70 text-slate-100'
          : 'text-slate-300 hover:bg-slate-700/50'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true">{item.icon}</span>
        <span>{item.label}</span>
      </span>
      {item.badge && (
        <span className="text-[10px] uppercase tracking-wide bg-slate-600 text-slate-200 rounded px-1.5 py-0.5">
          {item.badge}
        </span>
      )}
    </Link>
  );
}
