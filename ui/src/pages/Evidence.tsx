import { useState, useCallback } from 'react';
import { api, type TimelineEvent, type TimelineResponse, type Contradiction } from '../lib/api';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';
import { MetricCard } from '../components/ui/MetricCard';
import { formatDate, cn } from '../lib/utils';
import { Search, AlertTriangle, FileText, Scale, Calendar, ShieldAlert } from 'lucide-react';

type EvidenceTab = 'timeline' | 'contradictions';

const EVENT_TYPE_STYLES: Record<string, { icon: typeof FileText; bg: string; text: string }> = {
  fact: { icon: FileText, bg: 'bg-blue-100', text: 'text-blue-700' },
  deadline: { icon: Calendar, bg: 'bg-purple-100', text: 'text-purple-700' },
  dispute: { icon: ShieldAlert, bg: 'bg-orange-100', text: 'text-orange-700' },
  document: { icon: FileText, bg: 'bg-green-100', text: 'text-green-700' },
};

export function Evidence() {
  const [caseId, setCaseId] = useState('');
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [activeTab, setActiveTab] = useState<EvidenceTab>('timeline');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    if (!caseId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [tl, ctr] = await Promise.all([
        api.getCaseTimeline(caseId),
        api.getCaseContradictions(caseId).catch(() => ({ caseId, contradictions: [] })),
      ]);
      setTimeline(tl);
      setContradictions(ctr.contradictions);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadTimeline();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Scale size={24} className="text-chitty-400" />
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Evidence Timeline</h1>
          <p className="text-chrome-muted text-xs">Unified case timeline from ChittyEvidence, deadlines, and disputes</p>
        </div>
      </div>

      {/* Case ID Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-card-muted" />
          <input
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            placeholder="Enter case ID (e.g. CC-DISPUTE-abc12345)"
            className="w-full pl-9 pr-3 py-2 rounded-xl bg-card-bg border border-card-border text-card-text text-sm focus:outline-none focus:ring-2 focus:ring-chitty-500/50"
          />
        </div>
        <ActionButton label={loading ? 'Loading...' : 'Load'} onClick={loadTimeline} loading={loading} disabled={!caseId.trim()} />
      </form>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-400 text-sm flex items-center gap-2">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {timeline && (
        <>
          {/* Summary Metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
            <MetricCard label="Total Events" value={String(timeline.eventCount)} />
            <MetricCard label="Facts" value={String(timeline.sources.facts)} valueClassName="text-blue-600" />
            <MetricCard label="Deadlines" value={String(timeline.sources.deadlines)} valueClassName="text-purple-600" />
            <MetricCard label="Disputes" value={String(timeline.sources.disputes)} valueClassName="text-orange-600" />
            <MetricCard label="Contradictions" value={String(contradictions.length)} valueClassName={contradictions.length > 0 ? 'text-urgency-red' : 'text-urgency-green'} />
          </div>

          {timeline.warnings && timeline.warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-400 text-sm">
              {timeline.warnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 bg-card-hover rounded-lg p-1 border border-card-border">
            {(['timeline', 'contradictions'] as EvidenceTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  activeTab === tab ? 'bg-chitty-600 text-white' : 'text-card-muted hover:text-card-text',
                )}
              >
                {tab === 'timeline' ? `Timeline (${timeline.eventCount})` : `Contradictions (${contradictions.length})`}
              </button>
            ))}
          </div>

          {/* Timeline View */}
          {activeTab === 'timeline' && (
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-4 top-0 bottom-0 w-px bg-card-border" />

              <div className="space-y-3">
                {timeline.events.map((event) => (
                  <TimelineEventCard key={event.id} event={event} />
                ))}
              </div>

              {timeline.events.length === 0 && (
                <Card className="text-center py-8 ml-8">
                  <p className="text-card-muted">No timeline events found for this case.</p>
                </Card>
              )}
            </div>
          )}

          {/* Contradictions View */}
          {activeTab === 'contradictions' && (
            <div className="space-y-3">
              {contradictions.length === 0 ? (
                <Card className="text-center py-8">
                  <p className="text-card-muted">No contradictions detected.</p>
                </Card>
              ) : (
                contradictions.map((c) => (
                  <Card key={c.id} urgency={c.severity === 'high' ? 'red' : c.severity === 'medium' ? 'amber' : null}>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="text-urgency-red shrink-0" />
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">{c.contradiction_type}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{c.severity}</span>
                        {c.resolution_status && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{c.resolution_status}</span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        <div className="bg-red-50 rounded-lg p-3 border border-red-100">
                          <p className="text-xs text-red-600 font-medium mb-1">Fact A</p>
                          <p className="text-sm text-card-text">{c.fact_a_text}</p>
                        </div>
                        <div className="bg-red-50 rounded-lg p-3 border border-red-100">
                          <p className="text-xs text-red-600 font-medium mb-1">Fact B</p>
                          <p className="text-sm text-card-text">{c.fact_b_text}</p>
                        </div>
                      </div>
                      {c.explanation && (
                        <p className="text-sm text-card-muted">{c.explanation}</p>
                      )}
                    </div>
                  </Card>
                ))
              )}
            </div>
          )}
        </>
      )}

      {!timeline && !loading && (
        <Card className="text-center py-12">
          <Scale size={48} className="mx-auto text-chrome-muted mb-4 opacity-30" />
          <p className="text-card-muted">Enter a case ID to view the unified evidence timeline.</p>
          <p className="text-card-muted text-sm mt-1">Combines facts, deadlines, disputes, and documents from across the ecosystem.</p>
        </Card>
      )}
    </div>
  );
}

function TimelineEventCard({ event }: { event: TimelineEvent }) {
  const style = EVENT_TYPE_STYLES[event.type] || EVENT_TYPE_STYLES.fact;
  const Icon = style.icon;

  return (
    <div className="flex gap-3 ml-1">
      <div className={cn('w-6 h-6 rounded-full flex items-center justify-center shrink-0 z-10', style.bg)}>
        <Icon size={12} className={style.text} />
      </div>
      <Card className="flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', style.bg, style.text)}>
                {event.type}
              </span>
              <span className="text-xs text-card-muted">{event.source}</span>
              {event.metadata?.confidence != null && (
                <span className="text-xs text-card-muted">{Math.round(Number(event.metadata.confidence) * 100)}% confidence</span>
              )}
            </div>
            <p className="text-card-text text-sm font-medium">{event.title}</p>
            {event.description && (
              <p className="text-card-muted text-xs mt-1 line-clamp-2">{event.description}</p>
            )}
          </div>
          <span className="text-xs text-card-muted shrink-0 font-mono">{formatDate(event.date)}</span>
        </div>
      </Card>
    </div>
  );
}
