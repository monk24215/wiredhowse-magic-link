'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// ---------------------------------------------------------------------------
// Types (mirrored from server page to avoid importing across boundaries)
// ---------------------------------------------------------------------------

interface SiteDetail {
  id: string;
  domain: string;
  state: 'pending_verification' | 'live' | 'disabled';
  site_key: string;
  verification_token: string;
  verified_at: string | null;
  verification_method: string | null;
  allowed_origins: string[];
  disabled_at: string | null;
  created_at: string;
  snippet_tag: string;
  verification_instructions: {
    dns: { record_type: string; name: string; value: string };
    meta: { tag: string; placement: string };
  };
}

interface SiteMetrics {
  active_sessions: number;
  logins_24h: number;
  logins_7d: number;
  logins_30d: number;
  last_activity_at: string | null;
}

interface SiteActionsProps {
  site: SiteDetail;
  metrics: SiteMetrics;
}

// ---------------------------------------------------------------------------
// Copy button helper
// ---------------------------------------------------------------------------

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button size="sm" variant="outline" onClick={handleCopy} type="button">
      {copied ? 'Copied!' : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Verify button
// ---------------------------------------------------------------------------

function VerifyButton({ siteId, onVerified }: { siteId: string; onVerified: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleVerify() {
    setError(null);
    setLoading(true);
    try {
      const result = await api.post<{ verified: boolean }>(`/dashboard/sites/${siteId}/verify`, {});
      if (result.verified) {
        setSuccess(true);
        onVerified();
      } else {
        setError(
          'Verification failed. Make sure the DNS record or meta tag is in place and try again.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert>
          <AlertDescription>Verification successful! Your site is now live.</AlertDescription>
        </Alert>
      )}
      <Button onClick={handleVerify} disabled={loading || success} type="button">
        {loading ? 'Checking…' : success ? 'Verified' : 'Verify now'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allowed origins editor
// ---------------------------------------------------------------------------

function AllowedOriginsEditor({
  siteId,
  initialOrigins,
}: {
  siteId: string;
  initialOrigins: string[];
}) {
  const [origins, setOrigins] = useState<string[]>(initialOrigins);
  const [newOrigin, setNewOrigin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function saveOrigins(updated: string[]) {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await api.patch(`/dashboard/sites/${siteId}`, { allowed_origins: updated });
      setOrigins(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to update origins.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newOrigin.trim();
    if (!trimmed) return;

    // An Origin is scheme + host only — no path, query string, or trailing slash.
    let normalized = trimmed;
    try {
      const u = new URL(trimmed);
      normalized = u.origin; // strips path, query, hash, trailing slash
    } catch {
      setError('Enter a valid URL, e.g. https://example.com');
      return;
    }

    if (origins.includes(normalized)) return;
    const updated = [...origins, normalized];
    await saveOrigins(updated);
    if (!error) setNewOrigin('');
  }

  async function handleRemove(origin: string) {
    await saveOrigins(origins.filter((o) => o !== origin));
  }

  return (
    <div className="space-y-3">
      {origins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No origins configured.</p>
      ) : (
        <ul className="space-y-2">
          {origins.map((origin) => (
            <li
              key={origin}
              className="flex items-center justify-between bg-muted rounded px-3 py-1.5"
            >
              <span className="font-mono text-sm">{origin}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive h-6 px-2"
                onClick={() => handleRemove(origin)}
                disabled={saving}
                type="button"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex gap-2">
        <Input
          type="url"
          placeholder="https://example.com"
          value={newOrigin}
          onChange={(e) => setNewOrigin(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" disabled={saving || !newOrigin.trim()} size="sm">
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && <p className="text-xs text-emerald-400">Origins updated.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disable / enable toggle
// ---------------------------------------------------------------------------

function DisableToggle({
  siteId,
  currentState,
  isVerified,
}: {
  siteId: string;
  currentState: SiteDetail['state'];
  isVerified: boolean;
}) {
  const [state, setState] = useState(currentState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDisabled = state === 'disabled';
  const canEnable = isDisabled && isVerified;

  async function handleToggle() {
    setError(null);
    setLoading(true);
    const newState = isDisabled ? 'live' : 'disabled';
    try {
      await api.patch(`/dashboard/sites/${siteId}`, { state: newState });
      setState(newState);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to update site state.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (state === 'pending_verification') {
    return (
      <p className="text-sm text-muted-foreground">
        Site must be verified before it can be enabled or disabled.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button
        variant={isDisabled ? 'default' : 'outline'}
        onClick={handleToggle}
        disabled={loading || (!canEnable && isDisabled)}
        type="button"
      >
        {loading
          ? 'Saving…'
          : isDisabled
            ? canEnable
              ? 'Enable site'
              : 'Enable site (verify first)'
            : 'Disable site'}
      </Button>
      {isDisabled && (
        <p className="text-xs text-muted-foreground">
          Site is disabled — no sessions can be created.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clear sessions button
// ---------------------------------------------------------------------------

function ClearSessionsButton({ siteId }: { siteId: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleClear() {
    setError(null);
    setLoading(true);
    try {
      await api.post(`/dashboard/sites/${siteId}/clear-sessions`, {});
      setDone(true);
      setShowConfirm(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to clear sessions.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="space-y-2">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {done && <p className="text-xs text-emerald-400">All sessions cleared.</p>}
        <Button
          variant="outline"
          onClick={() => setShowConfirm(true)}
          disabled={done}
          type="button"
        >
          Clear all sessions
        </Button>
        <p className="text-xs text-muted-foreground">
          Immediately invalidates every active End User session for this site.
        </p>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#1d2026] border border-border rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="font-semibold">Clear all sessions?</h3>
            <p className="text-sm text-muted-foreground">
              Every active End User session will be invalidated immediately. They will need to
              request a new magic link to log in again.
            </p>
            <div className="flex gap-3">
              <Button variant="destructive" onClick={handleClear} disabled={loading} type="button">
                {loading ? 'Clearing…' : 'Clear sessions'}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                type="button"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Delete site button
// ---------------------------------------------------------------------------

function DeleteSiteButton({ siteId, domain }: { siteId: string; domain: string }) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setError(null);
    setLoading(true);
    try {
      await api.delete(`/dashboard/sites/${siteId}`);
      router.push('/sites');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to delete site.');
      }
      setLoading(false);
    }
  }

  const confirmed = confirm === domain;

  return (
    <>
      <div className="space-y-2">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button variant="destructive" onClick={() => setShowConfirm(true)} type="button">
          Delete site
        </Button>
        <p className="text-xs text-muted-foreground">
          Permanently deletes this site and all associated data. Cannot be undone.
        </p>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#1d2026] border border-border rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="font-semibold text-destructive">Delete site?</h3>
            <p className="text-sm text-muted-foreground">
              This will permanently delete <strong>{domain}</strong> and all its data including
              sessions, verification records, and settings. This cannot be undone.
            </p>
            <div className="space-y-2">
              <Label htmlFor="confirm-domain">
                Type <strong>{domain}</strong> to confirm
              </Label>
              <Input
                id="confirm-domain"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={domain}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex gap-3">
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={!confirmed || loading}
                type="button"
              >
                {loading ? 'Deleting…' : 'Delete site'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowConfirm(false);
                  setConfirm('');
                }}
                disabled={loading}
                type="button"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main client component — renders all sections
// ---------------------------------------------------------------------------

export function SiteActions({ site, metrics }: SiteActionsProps) {
  const [verified, setVerified] = useState(site.state !== 'pending_verification');
  const effectiveState = verified && site.state === 'pending_verification' ? 'live' : site.state;

  const { dns, meta } = site.verification_instructions;

  return (
    <div className="space-y-8">
      {/* Verification panel */}
      {site.state === 'pending_verification' && !verified && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Verify domain ownership</CardTitle>
            <CardDescription>
              Choose one method below, then click &ldquo;Verify now&rdquo;.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* DNS */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Option A — DNS TXT record</p>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-24 text-xs text-muted-foreground shrink-0">Type</span>
                  <span className="font-mono text-sm bg-muted px-2 py-1 rounded">
                    {dns.record_type}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-xs text-muted-foreground shrink-0">Name</span>
                  <span className="font-mono text-sm bg-muted px-2 py-1 rounded flex-1 break-all">
                    {dns.name}
                  </span>
                  <CopyButton text={dns.name} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 text-xs text-muted-foreground shrink-0">Value</span>
                  <span className="font-mono text-sm bg-muted px-2 py-1 rounded flex-1 break-all">
                    {dns.value}
                  </span>
                  <CopyButton text={dns.value} />
                </div>
              </div>
            </div>

            <div className="border-t pt-6 space-y-3">
              <p className="text-sm font-medium">Option B — Meta tag</p>
              <p className="text-xs text-muted-foreground">
                Paste in the <code>&lt;head&gt;</code> of your homepage ({meta.placement}).
              </p>
              <div className="flex items-start gap-2">
                <pre className="font-mono text-xs bg-muted px-3 py-2 rounded flex-1 overflow-x-auto whitespace-pre-wrap break-all">
                  {meta.tag}
                </pre>
                <CopyButton text={meta.tag} />
              </div>
            </div>

            <div className="border-t pt-6">
              <VerifyButton siteId={site.id} onVerified={() => setVerified(true)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Snippet */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Embed snippet</CardTitle>
          <CardDescription>
            Paste this script tag on every page where you want magic-link auth.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2">
            <pre className="font-mono text-xs bg-muted px-3 py-2 rounded flex-1 overflow-x-auto whitespace-pre-wrap break-all">
              {site.snippet_tag}
            </pre>
            <CopyButton text={site.snippet_tag} />
          </div>
        </CardContent>
      </Card>

      {/* Allowed origins */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allowed origins</CardTitle>
          <CardDescription>
            Only requests from these origins are accepted. Include the full origin with protocol
            (e.g. <code>https://example.com</code>).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AllowedOriginsEditor siteId={site.id} initialOrigins={site.allowed_origins} />
        </CardContent>
      </Card>

      {/* Metrics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Active sessions</dt>
              <dd className="text-2xl font-semibold mt-1">{metrics.active_sessions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Logins (24 h)</dt>
              <dd className="text-2xl font-semibold mt-1">{metrics.logins_24h}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Logins (7 d)</dt>
              <dd className="text-2xl font-semibold mt-1">{metrics.logins_7d}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Logins (30 d)</dt>
              <dd className="text-2xl font-semibold mt-1">{metrics.logins_30d}</dd>
            </div>
          </dl>
          {metrics.last_activity_at && (
            <p className="text-xs text-muted-foreground mt-4">
              Last activity:{' '}
              {new Date(metrics.last_activity_at).toLocaleString('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium">Site state</p>
            <DisableToggle siteId={site.id} currentState={effectiveState} isVerified={verified} />
          </div>

          <div className="border-t pt-6 space-y-2">
            <p className="text-sm font-medium">Clear sessions</p>
            <ClearSessionsButton siteId={site.id} />
          </div>

          <div className="border-t pt-6 space-y-2">
            <p className="text-sm font-medium">Delete site</p>
            <DeleteSiteButton siteId={site.id} domain={site.domain} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
