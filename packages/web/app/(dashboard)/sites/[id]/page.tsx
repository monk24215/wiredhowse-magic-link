import { ServerApiError, serverApi } from '@/lib/server-api';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteActions } from './site-actions';

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

const STATE_BADGE: Record<SiteDetail['state'], string> = {
  pending_verification: 'bg-yellow-100 text-yellow-800',
  live: 'bg-green-100 text-green-800',
  disabled: 'bg-gray-100 text-gray-600',
};

const STATE_LABEL: Record<SiteDetail['state'], string> = {
  pending_verification: 'Pending verification',
  live: 'Live',
  disabled: 'Disabled',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SiteDetailPage({ params }: PageProps) {
  const { id } = await params;

  let site: SiteDetail;
  let metrics: SiteMetrics;

  try {
    [site, metrics] = await Promise.all([
      serverApi.get<SiteDetail>(`/dashboard/sites/${id}`),
      serverApi.get<SiteMetrics>(`/dashboard/sites/${id}/metrics`),
    ]);
  } catch (err) {
    if (err instanceof ServerApiError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <Link
          href="/sites"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors mb-3 inline-block"
        >
          ← Back to sites
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{site.domain}</h1>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATE_BADGE[site.state]}`}
          >
            {STATE_LABEL[site.state]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground font-mono mt-1">{site.site_key}</p>
      </div>

      {/* Pass all interactive work to a client component */}
      <SiteActions site={site} metrics={metrics} />
    </div>
  );
}
