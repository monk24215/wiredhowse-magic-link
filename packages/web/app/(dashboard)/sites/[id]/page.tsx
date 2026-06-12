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
  pending_verification: 'bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/30',
  live: 'bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/30',
  disabled: 'bg-[#2a2e37]/50 text-[#777e8b] ring-1 ring-[#2a2e37]',
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
    const [siteRes, metricsRes] = await Promise.all([
      serverApi.get<{ site: SiteDetail }>(`/dashboard/sites/${id}`),
      serverApi.get<SiteMetrics>(`/dashboard/sites/${id}/metrics`),
    ]);
    site = siteRes.site;
    metrics = metricsRes;
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
