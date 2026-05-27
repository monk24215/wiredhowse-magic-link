import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ServerApiError, serverApi } from '@/lib/server-api';
import Link from 'next/link';

interface SiteItem {
  id: string;
  domain: string;
  state: 'pending_verification' | 'live' | 'disabled';
  site_key: string;
  verified_at: string | null;
  created_at: string;
  allowed_origins: string[];
}

const STATE_BADGE: Record<SiteItem['state'], string> = {
  pending_verification: 'bg-yellow-100 text-yellow-800',
  live: 'bg-green-100 text-green-800',
  disabled: 'bg-gray-100 text-gray-600',
};

const STATE_LABEL: Record<SiteItem['state'], string> = {
  pending_verification: 'Pending verification',
  live: 'Live',
  disabled: 'Disabled',
};

export default async function SitesPage() {
  let sites: SiteItem[] = [];
  let fetchError: string | null = null;

  try {
    const result = await serverApi.get<{ sites: SiteItem[] }>('/dashboard/sites');
    sites = result.sites;
  } catch (err) {
    if (err instanceof ServerApiError) {
      fetchError = err.message;
    } else {
      fetchError = 'Could not load sites. Please refresh the page.';
    }
  }

  const atLimit = sites.length >= 3;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sites</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage the sites where magic-link auth is enabled.
          </p>
        </div>
        <Button asChild={!atLimit} disabled={atLimit} size="sm">
          {atLimit ? <span>Add site</span> : <Link href="/sites/new">Add site</Link>}
        </Button>
      </div>

      {atLimit && (
        <p className="text-xs text-muted-foreground">
          You&apos;ve reached the 3-site limit. Remove a site to add a new one.
        </p>
      )}

      {fetchError && (
        <Alert variant="destructive">
          <AlertDescription>{fetchError}</AlertDescription>
        </Alert>
      )}

      {!fetchError && sites.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground text-sm">No sites yet.</p>
            <Button asChild className="mt-4" size="sm">
              <Link href="/sites/new">Add your first site</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {sites.map((site) => (
        <Link key={site.id} href={`/sites/${site.id}`} className="block group">
          <Card className="transition-shadow group-hover:shadow-md">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base font-medium">{site.domain}</CardTitle>
                <span
                  className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATE_BADGE[site.state]}`}
                >
                  {STATE_LABEL[site.state]}
                </span>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xs text-muted-foreground font-mono">{site.site_key}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Added{' '}
                {new Date(site.created_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
