'use client';

/**
 * /me — End User self-service dashboard.
 *
 * Auth scheme: Bearer token, NOT cookies. The token comes from:
 *   1. URL hash on first arrival: #wh_session=wh_s_<token>  (set by snippet)
 *   2. sessionStorage key "wh_me_session" on subsequent renders in the tab
 *
 * This is intentionally separate from the Site Owner dashboard which uses the
 * `wh_owner_session` cookie. The two auth schemes must not interfere.
 *
 * After "close and archive":
 *   - sessionStorage["wh_me_session"] is cleared.
 *   - The user is redirected to /me/archived (a generic confirmation page).
 *   - The localStorage on the customer site cannot be cleared from here
 *     (different origin). The End User should close the customer site tab
 *     or wait for the session to expire naturally.
 */

import { MeApiError, meApi } from '@/lib/me-api';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Profile {
  id: string;
  email: string;
  email_verified_at: string | null;
  display_name: string | null;
  created_at: string;
  last_seen_at: string | null;
}

interface Session {
  id: string;
  site_id: string;
  site_domain: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  is_current: boolean;
}

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

const SESSION_STORAGE_KEY = 'wh_me_session';

function readTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.slice(1)); // strip leading '#'
  return params.get('wh_session');
}

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(SESSION_STORAGE_KEY);
}

function storeToken(token: string): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, token);
}

function clearStoredToken(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Inline components
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="max-w-lg mx-auto mt-16 p-6 bg-destructive/10 border border-destructive/30 rounded-lg">
      <h2 className="text-lg font-semibold text-destructive mb-2">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function NotAuthenticated() {
  return (
    <div className="max-w-lg mx-auto mt-16 p-6 text-center space-y-4">
      <h1 className="text-2xl font-semibold">Sign in required</h1>
      <p className="text-muted-foreground text-sm">
        To view your account, visit a site that uses wiredHowse Auth and sign in with your email.
        You&apos;ll be brought back here automatically.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Close-and-archive modal
// ---------------------------------------------------------------------------

interface ArchiveModalProps {
  onConfirm: () => Promise<void>;
  onClose: () => void;
  busy: boolean;
}

function ArchiveModal({ onConfirm, onClose, busy }: ArchiveModalProps) {
  const [typed, setTyped] = useState('');
  const required = 'DELETE MY DATA';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <h2 className="text-xl font-semibold text-destructive">Archive your data</h2>
        <p className="text-sm text-muted-foreground">
          This will permanently delete your account and all sessions. An anonymised summary is
          retained for security purposes only.{' '}
          <strong>This cannot be undone.</strong>
        </p>
        <p className="text-sm">
          Type <code className="bg-muted px-1 rounded">{required}</code> to confirm:
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={required}
          className="w-full border rounded px-3 py-2 text-sm font-mono"
          disabled={busy}
          autoFocus
        />
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md border hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={typed !== required || busy}
            className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Archiving…' : 'Archive my data'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function MePage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null); // session ID being revoked
  const [revokingAll, setRevokingAll] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archivingBusy, setArchivingBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Track whether we've done the initial token+data load
  const initialised = useRef(false);

  // Step 1: resolve the token once on mount
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    // Check URL hash first (arrival from snippet)
    const hashToken = readTokenFromHash();
    if (hashToken) {
      storeToken(hashToken);
      // Remove from address bar so the token isn't bookmarked / sent to server
      history.replaceState(null, '', window.location.pathname);
      setToken(hashToken);
      return;
    }

    // Fall back to sessionStorage (returning to the page within same tab)
    const stored = getStoredToken();
    setToken(stored);
  }, []);

  // Step 2: load profile + sessions when we have a token
  useEffect(() => {
    if (token === null) {
      // Done resolving, no token found
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      if (!token) return;
      try {
        const [profileData, sessionsData] = await Promise.all([
          meApi.get<Profile>('/me', token),
          meApi.get<{ sessions: Session[] }>('/me/sessions', token),
        ]);
        if (!cancelled) {
          setProfile(profileData);
          setSessions(sessionsData.sessions);
          setNameInput(profileData.display_name ?? '');
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof MeApiError && err.status === 401) {
            // Session expired or invalid
            clearStoredToken();
            setToken(null);
          } else {
            setError('Failed to load your account. Please try again.');
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleRevokeSession = useCallback(
    async (sessionId: string) => {
      if (!token) return;
      setRevoking(sessionId);
      try {
        await meApi.post(`/me/sessions/${sessionId}/revoke`, token);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      } catch {
        setError('Failed to revoke session. Please try again.');
      } finally {
        setRevoking(null);
      }
    },
    [token],
  );

  const handleRevokeAll = useCallback(async () => {
    if (!token) return;
    setRevokingAll(true);
    try {
      await meApi.post('/me/sessions/revoke-all', token);
      setSessions([]);
      // Our own session is revoked — clear local state and show unauthenticated
      clearStoredToken();
      setToken(null);
    } catch {
      setError('Failed to revoke sessions. Please try again.');
    } finally {
      setRevokingAll(false);
    }
  }, [token]);

  const handleSaveName = useCallback(async () => {
    if (!token) return;
    setSavingName(true);
    try {
      const updated = await meApi.patch<Profile>('/me', token, {
        display_name: nameInput.trim() || null,
      });
      setProfile(updated);
      setEditingName(false);
    } catch {
      setError('Failed to save display name. Please try again.');
    } finally {
      setSavingName(false);
    }
  }, [token, nameInput]);

  const handleCloseAndArchive = useCallback(async () => {
    if (!token) return;
    setArchivingBusy(true);
    try {
      await meApi.post('/me/close-and-archive', token, { confirmation: 'DELETE MY DATA' });
      // Clear all local state — the user no longer exists
      clearStoredToken();
      router.replace('/me/archived');
    } catch {
      setArchivingBusy(false);
      setShowArchiveModal(false);
      setError('Failed to archive your data. Please try again or contact support.');
    }
  }, [token, router]);

  const handleDownloadExport = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/v1/me/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wiredhowse-data-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to download your data. Please try again.');
    }
  }, [token]);

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (loading) return <Spinner />;
  if (!token) return <NotAuthenticated />;
  if (error) return <ErrorMessage message={error} />;
  if (!profile) return <ErrorMessage message="Could not load your profile." />;

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-10">
      {showArchiveModal && (
        <ArchiveModal
          onConfirm={handleCloseAndArchive}
          onClose={() => setShowArchiveModal(false)}
          busy={archivingBusy}
        />
      )}

      {/* ── Profile ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Your account</h1>

        <div className="border rounded-lg p-4 space-y-3">
          <div>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Email</span>
            <p className="text-sm font-medium">{profile.email}</p>
          </div>
          <div>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Display name
            </span>
            {editingName ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={100}
                  className="border rounded px-2 py-1 text-sm flex-1"
                  disabled={savingName}
                />
                <button
                  type="button"
                  onClick={() => void handleSaveName()}
                  disabled={savingName}
                  className="px-3 py-1 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {savingName ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNameInput(profile.display_name ?? '');
                    setEditingName(false);
                  }}
                  disabled={savingName}
                  className="px-3 py-1 text-sm rounded border hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-sm">{profile.display_name ?? '—'}</p>
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  className="text-xs text-muted-foreground underline hover:text-foreground"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
          <div>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Account created
            </span>
            <p className="text-sm">{new Date(profile.created_at).toLocaleDateString()}</p>
          </div>
        </div>
      </section>

      {/* ── Active sessions ──────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Active sessions</h2>
          {sessions.length > 0 && (
            <button
              type="button"
              onClick={() => void handleRevokeAll()}
              disabled={revokingAll}
              className="text-sm text-destructive underline hover:no-underline disabled:opacity-50"
            >
              {revokingAll ? 'Revoking…' : 'Sign out of all sessions'}
            </button>
          )}
        </div>

        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((sess) => (
              <li
                key={sess.id}
                className="border rounded-lg p-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {sess.site_domain}
                    {sess.is_current && (
                      <span className="ml-2 text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                        this session
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last active {new Date(sess.last_used_at).toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(sess.expires_at).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeSession(sess.id)}
                  disabled={revoking === sess.id}
                  className="shrink-0 text-xs text-muted-foreground border rounded px-2 py-1 hover:bg-muted disabled:opacity-50"
                >
                  {revoking === sess.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Data & privacy ───────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Data &amp; privacy</h2>
        <div className="border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Download your data</p>
              <p className="text-xs text-muted-foreground">
                Export your profile, session history, and login activity as JSON.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleDownloadExport()}
              className="shrink-0 text-sm border rounded px-3 py-1.5 hover:bg-muted transition-colors"
            >
              Download
            </button>
          </div>

          <hr />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-destructive">Close and archive my data</p>
              <p className="text-xs text-muted-foreground">
                Permanently deletes your account. An anonymised record is retained for 24 months
                for security purposes.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowArchiveModal(true)}
              className="shrink-0 text-sm border border-destructive text-destructive rounded px-3 py-1.5 hover:bg-destructive/10 transition-colors"
            >
              Archive
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
