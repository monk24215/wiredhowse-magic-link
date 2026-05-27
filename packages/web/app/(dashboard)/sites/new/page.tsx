'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import Link from 'next/link';
import { useState } from 'react';

interface CreatedSite {
  id: string;
  domain: string;
  site_key: string;
  snippet_tag: string;
  verification_instructions: {
    dns: { record_type: string; name: string; value: string };
    meta: { tag: string; placement: string };
  };
}

interface CreateSiteResponse {
  site: CreatedSite;
}

export default function NewSitePage() {
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSite | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await api.post<CreateSiteResponse>('/dashboard/sites', { domain });
      setCreated(result.site);
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'SITE_LIMIT_REACHED':
            setError("You've reached the 3-site limit.");
            break;
          case 'DOMAIN_ALREADY_REGISTERED':
            setError('This domain is already registered.');
            break;
          case 'VALIDATION_ERROR':
            setError(err.message);
            break;
          default:
            setError('Something went wrong. Please try again.');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function copyText(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  if (created) {
    const { dns, meta } = created.verification_instructions;

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Site created</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Follow the steps below to verify ownership of <strong>{created.domain}</strong>.
          </p>
        </div>

        {/* DNS verification */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Option A — DNS TXT record</CardTitle>
            <CardDescription>
              Add this TXT record to your DNS provider. Changes may take up to 48 hours.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Record type</p>
              <p className="font-mono text-sm bg-muted px-3 py-2 rounded">{dns.record_type}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Name / Host</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm bg-muted px-3 py-2 rounded flex-1 break-all">
                  {dns.name}
                </p>
                <Button size="sm" variant="outline" onClick={() => copyText(dns.name, 'dns-name')}>
                  {copied === 'dns-name' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Value</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm bg-muted px-3 py-2 rounded flex-1 break-all">
                  {dns.value}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyText(dns.value, 'dns-value')}
                >
                  {copied === 'dns-value' ? 'Copied!' : 'Copy'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Meta tag verification */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Option B — Meta tag</CardTitle>
            <CardDescription>
              Paste this tag in the <code>&lt;head&gt;</code> of your homepage ({meta.placement}).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <pre className="font-mono text-xs bg-muted px-3 py-2 rounded flex-1 overflow-x-auto whitespace-pre-wrap break-all">
                {meta.tag}
              </pre>
              <Button size="sm" variant="outline" onClick={() => copyText(meta.tag, 'meta-tag')}>
                {copied === 'meta-tag' ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Snippet */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Embed snippet</CardTitle>
            <CardDescription>
              Paste this script tag on every page where you want magic-link auth.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <pre className="font-mono text-xs bg-muted px-3 py-2 rounded flex-1 overflow-x-auto whitespace-pre-wrap break-all">
                {created.snippet_tag}
              </pre>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyText(created.snippet_tag, 'snippet')}
              >
                {copied === 'snippet' ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button asChild>
            <Link href={`/sites/${created.id}`}>Go to site</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/sites">Back to sites</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Add a site</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter the domain where you want to enable magic-link authentication.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                type="text"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Without protocol — e.g. <code>example.com</code>, not{' '}
                <code>https://example.com</code>
              </p>
            </div>

            <div className="flex gap-3">
              <Button type="submit" disabled={loading}>
                {loading ? 'Creating…' : 'Create site'}
              </Button>
              <Button asChild variant="outline">
                <Link href="/sites">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
