'use client';

/**
 * OperatorUserListClient — operator user table with action menu (Phase H10).
 *
 * Renders the dark V1 table for /sistem/kullanicilar:
 *   Columns: Kullanıcı Adı, Tam Ad, E-posta, Rol, 2FA, Aktif, Son Giriş,
 *            Oluşturma, Actions.
 *
 * The action column hosts a dropdown with:
 *   - Düzenle           → /sistem/kullanicilar/[id]
 *   - 2FA Sıfırla       → opens <Reset2FADialog>
 *   - Şifre Sıfırla     → opens <ResetPasswordDialog>
 *   - Pasifleştir/Aktifleştir (PATCH isActive)
 *   - Sil               (DELETE — soft-delete, sets is_active=false)
 *
 * Self-protection: when a row's `id` equals `currentUserId`, the destructive
 * actions (Pasifleştir, Sil) are disabled with a tooltip. The backend also
 * enforces this — the UI guard is a UX nicety so admins don't lock
 * themselves out by accident.
 *
 * Lockout indicator: rows whose `failedLoginLockedUntil` is in the future
 * render a small red "Kilitli" badge next to the username so admins can
 * spot brute-forced accounts at a glance.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { OperatorRoleBadge } from './OperatorRoleBadge';
import { Reset2FADialog } from './Reset2FADialog';
import { ResetPasswordDialog } from './ResetPasswordDialog';

export interface OperatorUserRow {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: 'admin' | 'operator';
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
  failedLoginLockedUntil: Date | null;
  createdAt: Date;
}

function formatDateTime(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('tr-TR');
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('tr-TR');
}

function isLockedOut(until: Date | null | undefined): boolean {
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

export function OperatorUserListClient({
  users,
  currentUserId,
}: {
  users: OperatorUserRow[];
  currentUserId: string;
}) {
  const router = useRouter();

  // Open menu id (only one open at a time). null = none open.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Active dialog: { kind: 'reset2fa' | 'resetpw', user: row } | null
  const [dialog, setDialog] = useState<
    | { kind: 'reset2fa'; user: OperatorUserRow }
    | { kind: 'resetpw'; user: OperatorUserRow }
    | null
  >(null);
  // Banner shown after toggle / delete actions.
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);
  // Pending row id (button disabled while inflight).
  const [pendingId, setPendingId] = useState<string | null>(null);

  function closeMenu() {
    setOpenMenuId(null);
  }

  async function handleToggleActive(user: OperatorUserRow) {
    closeMenu();
    if (user.id === currentUserId) {
      setBanner({
        kind: 'error',
        text: 'Kendi hesabınızı pasifleştiremezsiniz.',
      });
      return;
    }
    setPendingId(user.id);
    try {
      const res = await fetch(`/api/internal/operator-users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!json.success) {
        setBanner({
          kind: 'error',
          text: json.error?.message ?? 'İşlem başarısız.',
        });
      } else {
        setBanner({
          kind: 'success',
          text: user.isActive
            ? `${user.username} pasifleştirildi.`
            : `${user.username} aktifleştirildi.`,
        });
        router.refresh();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Sunucuya ulaşılamadı.' });
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(user: OperatorUserRow) {
    closeMenu();
    if (user.id === currentUserId) {
      setBanner({
        kind: 'error',
        text: 'Kendi hesabınızı silemezsiniz.',
      });
      return;
    }
    if (
      !window.confirm(
        `'${user.username}' kullanıcısını silmek istediğinize emin misiniz?\n\n` +
          'Bu işlem hesabı pasifleştirir (yumuşak silme). Audit kayıtları korunur.',
      )
    ) {
      return;
    }
    setPendingId(user.id);
    try {
      const res = await fetch(`/api/internal/operator-users/${user.id}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!json.success) {
        setBanner({
          kind: 'error',
          text: json.error?.message ?? 'Silme işlemi başarısız.',
        });
      } else {
        setBanner({ kind: 'success', text: `${user.username} silindi.` });
        router.refresh();
      }
    } catch {
      setBanner({ kind: 'error', text: 'Sunucuya ulaşılamadı.' });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Kullanıcılar</h1>
          <p className="text-sm text-slate-400 mt-1">
            Operatör hesaplarını yönet. Toplam {users.length} kayıt.
          </p>
        </div>
        <Link
          href="/sistem/kullanicilar/yeni"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm"
        >
          + Yeni Kullanıcı
        </Link>
      </header>

      {banner ? (
        <div
          className={`px-4 py-3 rounded-md text-sm border ${
            banner.kind === 'success'
              ? 'bg-emerald-900/30 border-emerald-700 text-emerald-200'
              : 'bg-red-900/30 border-red-700 text-red-200'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Kapat
            </button>
          </div>
        </div>
      ) : null}

      <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
        <table className="w-full text-sm text-slate-100">
          <thead className="bg-slate-700/60 text-xs uppercase tracking-wide text-slate-300">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Kullanıcı Adı</th>
              <th className="px-4 py-3 text-left font-semibold">Tam Ad</th>
              <th className="px-4 py-3 text-left font-semibold">E-posta</th>
              <th className="px-4 py-3 text-left font-semibold">Rol</th>
              <th className="px-4 py-3 text-center font-semibold">2FA</th>
              <th className="px-4 py-3 text-center font-semibold">Aktif</th>
              <th className="px-4 py-3 text-left font-semibold">Son Giriş</th>
              <th className="px-4 py-3 text-left font-semibold">Oluşturma</th>
              <th className="px-4 py-3 text-right font-semibold w-12">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const locked = isLockedOut(u.failedLoginLockedUntil);
              const isSelf = u.id === currentUserId;
              const isPending = pendingId === u.id;
              return (
                <tr
                  key={u.id}
                  className="border-t border-slate-700 hover:bg-slate-700/40"
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-200">
                    <div className="flex items-center gap-2">
                      <span>{u.username}</span>
                      {isSelf ? (
                        <span className="text-[10px] uppercase tracking-wide bg-blue-900/40 text-blue-300 rounded px-1.5 py-0.5">
                          Siz
                        </span>
                      ) : null}
                      {locked ? (
                        <span
                          className="text-[10px] uppercase tracking-wide bg-red-900/40 text-red-300 rounded px-1.5 py-0.5"
                          title={`Kilit ${formatDateTime(u.failedLoginLockedUntil)} tarihine kadar`}
                        >
                          Kilitli
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">{u.fullName}</td>
                  <td className="px-4 py-3 text-slate-300">{u.email}</td>
                  <td className="px-4 py-3">
                    <OperatorRoleBadge role={u.role} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    {u.twoFactorEnabled ? (
                      <span className="text-emerald-400" aria-label="2FA aktif">
                        ✓
                      </span>
                    ) : (
                      <span className="text-slate-500" aria-label="2FA pasif">
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {u.isActive ? (
                      <span className="text-emerald-400">✓</span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {formatDateTime(u.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right relative">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenMenuId(openMenuId === u.id ? null : u.id)
                      }
                      disabled={isPending}
                      className="p-2 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700/50 disabled:opacity-40"
                      aria-haspopup="menu"
                      aria-expanded={openMenuId === u.id}
                    >
                      ⋮
                    </button>
                    {openMenuId === u.id ? (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={closeMenu}
                          aria-hidden="true"
                        />
                        <div
                          role="menu"
                          className="absolute right-2 top-12 z-20 w-52 bg-slate-800 border border-slate-700 rounded-md shadow-xl overflow-hidden text-left"
                        >
                          <Link
                            href={`/sistem/kullanicilar/${u.id}`}
                            role="menuitem"
                            onClick={closeMenu}
                            className="block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50"
                          >
                            Düzenle
                          </Link>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu();
                              setDialog({ kind: 'reset2fa', user: u });
                            }}
                            className="w-full text-left block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50"
                          >
                            2FA Sıfırla
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu();
                              setDialog({ kind: 'resetpw', user: u });
                            }}
                            className="w-full text-left block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50"
                          >
                            Şifre Sıfırla
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={isSelf}
                            onClick={() => handleToggleActive(u)}
                            className="w-full text-left block px-3 py-2 text-sm text-slate-200 hover:bg-slate-700/50 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={
                              isSelf
                                ? 'Kendi hesabınızı pasifleştiremezsiniz'
                                : undefined
                            }
                          >
                            {u.isActive ? 'Pasifleştir' : 'Aktifleştir'}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={isSelf}
                            onClick={() => handleDelete(u)}
                            className="w-full text-left block px-3 py-2 text-sm text-red-300 hover:bg-red-900/30 border-t border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={
                              isSelf
                                ? 'Kendi hesabınızı silemezsiniz'
                                : undefined
                            }
                          >
                            Sil
                          </button>
                        </div>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-12 text-center text-sm text-slate-400"
                >
                  Henüz operatör kullanıcı yok. Yeni Kullanıcı butonu ile
                  ekleyin.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'reset2fa' ? (
        <Reset2FADialog
          userId={dialog.user.id}
          username={dialog.user.username}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setBanner({
              kind: 'success',
              text: `${dialog.user.username} için 2FA sıfırlandı.`,
            });
            router.refresh();
          }}
        />
      ) : null}

      {dialog?.kind === 'resetpw' ? (
        <ResetPasswordDialog
          userId={dialog.user.id}
          username={dialog.user.username}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setBanner({
              kind: 'success',
              text: `${dialog.user.username} için yeni şifre üretildi.`,
            });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
