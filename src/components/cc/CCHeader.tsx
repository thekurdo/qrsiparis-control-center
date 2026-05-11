'use client';

/**
 * CCHeader — sticky 56px topbar (Phase H9+).
 *
 * Right-aligned: avatar + dropdown with:
 *   - {username} (role badge)
 *   - Şifremi Değiştir
 *   - 2FA Yönet                (V1 stub — links to /sistem/ayarlar)
 *   - Çıkış
 *
 * Left side stays empty in V1 — page-level h1's act as the visual anchor.
 * A breadcrumb component can be slotted in here in V1.5.
 */

import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { OperatorRole } from '@/lib/auth/middleware';

export interface CCHeaderUser {
  id: string;
  username: string;
  role: OperatorRole;
  email?: string | null;
  name?: string | null;
}

export function CCHeader({ user }: { user: CCHeaderUser }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = (user.name?.[0] ?? user.username[0] ?? '?').toUpperCase();
  const roleLabel = user.role === 'admin' ? 'Yönetici' : 'Operatör';

  async function handleSignOut() {
    setOpen(false);
    await signOut({ callbackUrl: '/login' });
  }

  return (
    <header className="h-14 shrink-0 sticky top-0 z-20 bg-slate-800 border-b border-slate-700 flex items-center justify-end px-6">
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-slate-700/50"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-semibold flex items-center justify-center">
            {initial}
          </span>
          <span className="hidden sm:flex flex-col items-start leading-tight">
            <span className="text-sm text-slate-100">{user.username}</span>
            <span className="text-[10px] uppercase tracking-wide text-slate-400">
              {roleLabel}
            </span>
          </span>
          <span aria-hidden="true" className="text-slate-500 text-xs ml-1">
            ▾
          </span>
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-56 bg-slate-800 border border-slate-700 rounded-md shadow-lg overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-slate-700">
              <div className="text-sm text-slate-100 truncate">
                {user.name ?? user.username}
              </div>
              <div className="text-xs text-slate-400">{roleLabel}</div>
            </div>

            <Link
              href="/sistem/ayarlar"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50"
            >
              Şifremi Değiştir
            </Link>
            <Link
              href="/sistem/ayarlar"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50"
            >
              2FA Yönet
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="w-full text-left block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50 border-t border-slate-700"
            >
              Çıkış
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
