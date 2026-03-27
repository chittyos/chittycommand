import { useState, useRef, useEffect } from 'react';
import { api, type Dispute } from '../lib/api';
import { Card } from '../components/ui/Card';
import { useToast } from '../lib/toast';
import {
  Scale, FileText, Shield, AlertTriangle, CheckCircle,
  Loader2, ChevronRight, Copy, Check, Save, Link2,
} from 'lucide-react';

type Step = 'idle' | 'synthesizing' | 'synthesized' | 'drafting' | 'drafted' | 'scanning' | 'scanned';
type QCFlag = { flagType: string; location: string; issue: string; suggestedFix: string };

const FOCUS_OPTIONS = [
  'Fee/escrow mechanics',
  'Case strategy update request',
  'Listing/sale logistics + disclosures',
  'Sanctions / motions',
  'General follow-up',
];

const FLAG_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  HALLUCINATION: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  MISSING: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  'OVER-DISCLOSURE': { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
  AMBIGUOUS: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
};

export function LitigationAssistant() {
  const [step, setStep] = useState<Step>('idle');
  const [rawNotes, setRawNotes] = useState('');
  const [property, setProperty] = useState('550 W Surf St, Unit 504, Chicago, IL');
  const [caseNumber, setCaseNumber] = useState('2024D007847');
  const [focus, setFocus] = useState(FOCUS_OPTIONS[0]);
  const [recipient, setRecipient] = useState('Robert Alexander');

  const [synthesis, setSynthesis] = useState('');
  const [draft, setDraft] = useState('');
  const [flags, setFlags] = useState<QCFlag[]>([]);
  const [qcWarning, setQcWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Dispute bridge state
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [selectedDisputeId, setSelectedDisputeId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const toast = useToast();

  const synthesisRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLDivElement>(null);

  // Load disputes for the picker
  useEffect(() => {
    api.getDisputes().then(setDisputes).catch(() => {});
  }, []);

  // Pre-populate from dispute context if URL has ?dispute=ID
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const disputeId = params.get('dispute');
    if (disputeId && disputes.length > 0) {
      setSelectedDisputeId(disputeId);
      const d = disputes.find(dd => dd.id === disputeId);
      if (d) {
        if (d.counterparty) setRecipient(d.counterparty);
        if (d.description) setRawNotes(prev => prev || d.description || '');
      }
    }
  }, [disputes]);

  const saveToDispute = async () => {
    if (!selectedDisputeId || !draft) return;
    setSaving(true);
    try {
      await api.addCorrespondence(selectedDisputeId, {
        direction: 'outbound',
        channel: 'email',
        subject: `Draft: ${focus}`,
        content: draft,
      });
      setSaved(true);
      toast.success('Saved to dispute', 'Draft added as correspondence');
      setTimeout(() => setSaved(false), 3000);
    } catch (e: unknown) {
      toast.error('Save failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const handleSynthesize = async () => {
    if (!rawNotes.trim()) return;
    setStep('synthesizing');
    setError(null);
    setSynthesis('');
    setDraft('');
    setFlags([]);
    setQcWarning(null);

    try {
      const res = await api.litigationSynthesize({ rawNotes, property, caseNumber });
      setSynthesis(res.synthesis);
      setStep('synthesized');
      setTimeout(() => synthesisRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synthesis failed');
      setStep('idle');
    }
  };

  const handleDraft = async () => {
    if (!synthesis) return;
    setStep('drafting');
    setError(null);

    try {
      const res = await api.litigationDraft({ synthesizedFacts: synthesis, focus, recipient });
      setDraft(res.draft);
      setStep('drafted');
      setTimeout(() => draftRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Draft failed');
      setStep('synthesized');
    }
  };

  const handleQC = async () => {
    if (!draft) return;
    setStep('scanning');
    setError(null);

    try {
      const res = await api.litigationQC({ rawNotes, draftEmail: draft });
      setFlags(res.flags || []);
      setQcWarning(res.warning || null);
      setStep('scanned');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QC scan failed');
      setStep('drafted');
    }
  };

  const copyDraft = () => {
    navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderTag = (text: string) => {
    return text
      .replace(/\[GIVEN\]/g, '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 mr-1">[GIVEN]</span>')
      .replace(/\[DERIVED\]/g, '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200 mr-1">[DERIVED]</span>')
      .replace(/\[UNKNOWN\]/g, '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200 mr-1">[UNKNOWN]</span>');
  };

  const isLoading = step === 'synthesizing' || step === 'drafting' || step === 'scanning';

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Scale size={24} className="text-chitty-400" />
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-chrome-text">Litigation Assistant</h1>
          <p className="text-chrome-muted text-xs">Strict evidentiary discipline — all facts tagged and traceable</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-400 text-sm flex items-center gap-2">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {/* Pipeline status */}
      <div className="flex items-center gap-2 text-xs">
        {(['Intake', 'Synthesize', 'Draft', 'QC'] as const).map((label, i) => {
          const stepMap = [['idle', 'synthesizing'], ['synthesized', 'drafting'], ['drafted', 'scanning'], ['scanned']];
          const active = stepMap[i]?.includes(step) || false;
          const done = i < stepMap.findIndex((s) => s.includes(step));
          return (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={12} className="text-chrome-muted" />}
              <span className={`px-2.5 py-1 rounded-full font-medium transition-colors ${
                active ? 'bg-chitty-600 text-white' :
                done ? 'bg-emerald-500/20 text-emerald-400' :
                'bg-chrome-border/40 text-chrome-muted'
              }`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* LEFT: Input Column */}
        <div className="space-y-4">

          {/* Raw Notes */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-chitty-600/20 text-chitty-400 flex items-center justify-center text-xs font-bold">1</div>
              <h3 className="font-semibold text-card-text">Source Material</h3>
            </div>
            <p className="text-card-muted text-xs mb-2">Paste call transcripts, email threads, notes, or docket excerpts.</p>
            <textarea
              value={rawNotes}
              onChange={(e) => setRawNotes(e.target.value)}
              placeholder="e.g. Rob called — Luisa's attorney is withdrawing. Paralegal drafting motion to quash TPO..."
              rows={8}
              className="w-full p-3 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm resize-none focus:outline-none focus:ring-2 focus:ring-chitty-500/50 focus:border-chitty-500"
            />
          </Card>

          {/* Context Variables */}
          <Card>
            <h3 className="font-semibold text-card-text mb-3 text-sm">Context</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Email Focus</label>
                <select
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                >
                  {FOCUS_OPTIONS.map((f) => <option key={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Recipient</label>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Property</label>
                <input
                  value={property}
                  onChange={(e) => setProperty(e.target.value)}
                  className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-card-muted mb-1">Case #</label>
                <input
                  value={caseNumber}
                  onChange={(e) => setCaseNumber(e.target.value)}
                  className="w-full p-2 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-sm focus:outline-none"
                />
              </div>
            </div>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2">
            <button
              onClick={handleSynthesize}
              disabled={!rawNotes.trim() || isLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-sm transition-all bg-chitty-600 hover:bg-chitty-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {step === 'synthesizing' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
              {step === 'synthesizing' ? 'Analyzing...' : 'Synthesize Facts'}
            </button>
            <button
              onClick={handleDraft}
              disabled={!synthesis || isLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-chitty-600 hover:bg-chitty-500 text-white"
            >
              {step === 'drafting' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
              {step === 'drafting' ? 'Drafting...' : 'Draft Email'}
            </button>
            <button
              onClick={handleQC}
              disabled={!draft || isLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-chrome-surface hover:bg-chrome-border text-chrome-text border border-chrome-border"
            >
              {step === 'scanning' ? <Loader2 size={16} className="animate-spin" /> : <Shield size={16} />}
              {step === 'scanning' ? 'Scanning...' : 'Risk Scan'}
            </button>
          </div>
        </div>

        {/* RIGHT: Output Column */}
        <div className="space-y-4">

          {/* Synthesis Output */}
          <div ref={synthesisRef}>
            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-card-text text-sm flex items-center gap-2">
                  <FileText size={14} className="text-chitty-500" />
                  Evidence Synthesis
                </h3>
                <span className="text-[9px] uppercase tracking-wider text-card-muted font-mono">Steps 1-2</span>
              </div>
              {synthesis ? (
                <div
                  className="prose prose-sm max-w-none text-card-text prose-headings:text-card-text prose-headings:text-sm prose-headings:font-bold prose-headings:mt-3 prose-headings:mb-1 prose-li:my-0.5"
                  dangerouslySetInnerHTML={{ __html: renderTag(
                    synthesis
                      .replace(/^## (.+)$/gm, '<h4 class="text-sm font-bold text-slate-800 mt-3 mb-1">$1</h4>')
                      .replace(/^- (.+)$/gm, '<div class="flex items-start gap-1 text-sm text-slate-700 my-1"><span class="text-slate-400 mt-0.5 shrink-0">&#8226;</span><span>$1</span></div>')
                      .replace(/\n\n/g, '<br/>')
                  )}}
                />
              ) : (
                <p className="text-card-muted text-sm text-center py-8 italic">
                  {step === 'synthesizing' ? 'Analyzing source material...' : 'Paste source material and run Synthesize Facts'}
                </p>
              )}
            </Card>
          </div>

          {/* Draft Output */}
          <div ref={draftRef}>
            <Card>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-card-text text-sm flex items-center gap-2">
                  <FileText size={14} className="text-chitty-500" />
                  Email Draft
                </h3>
                <div className="flex items-center gap-2">
                  {draft && (
                    <>
                      <button
                        onClick={copyDraft}
                        className="text-xs flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-card-muted transition-colors"
                      >
                        {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        onClick={saveToDispute}
                        disabled={!selectedDisputeId || saving}
                        className="text-xs flex items-center gap-1 px-2 py-1 rounded-lg bg-chitty-100 hover:bg-chitty-200 text-chitty-700 transition-colors disabled:opacity-40"
                      >
                        {saved ? <Check size={12} className="text-emerald-600" /> : saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {saved ? 'Saved' : 'Save to Dispute'}
                      </button>
                    </>
                  )}
                  <span className="text-[9px] uppercase tracking-wider text-card-muted font-mono">Step 3</span>
                </div>
              </div>
              {/* Dispute picker */}
              {draft && (
                <div className="flex items-center gap-2 mb-3">
                  <Link2 size={14} className="text-card-muted shrink-0" />
                  <select
                    value={selectedDisputeId}
                    onChange={(e) => setSelectedDisputeId(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-card-text text-xs focus:outline-none"
                  >
                    <option value="">Link to dispute...</option>
                    {disputes.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({d.counterparty})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {draft ? (
                <div className="bg-slate-50 rounded-lg p-4 text-sm text-card-text whitespace-pre-wrap font-serif leading-relaxed border border-slate-100">
                  {draft}
                </div>
              ) : (
                <p className="text-card-muted text-sm text-center py-8 italic">
                  {step === 'drafting' ? 'Generating draft...' : 'Run Draft Email after synthesis'}
                </p>
              )}
            </Card>
          </div>

          {/* QC Output */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-card-text text-sm flex items-center gap-2">
                <Shield size={14} className="text-chitty-500" />
                Risk QC Report
              </h3>
              <span className="text-[9px] uppercase tracking-wider text-card-muted font-mono">Step 4</span>
            </div>
            {step === 'scanned' ? (
              flags.length === 0 && qcWarning ? (
                <div className="text-center py-6">
                  <AlertTriangle size={32} className="mx-auto text-amber-500 mb-2" />
                  <p className="font-semibold text-amber-700">Scan Incomplete</p>
                  <p className="text-sm text-card-muted mt-1">{qcWarning}</p>
                  <button
                    onClick={handleQC}
                    disabled={isLoading}
                    className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 transition-colors"
                  >
                    Retry Scan
                  </button>
                </div>
              ) : flags.length === 0 ? (
                <div className="text-center py-6">
                  <CheckCircle size={32} className="mx-auto text-emerald-500 mb-2" />
                  <p className="font-semibold text-emerald-700">Clear</p>
                  <p className="text-sm text-card-muted mt-1">No risk flags identified in the current draft.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {flags.map((flag, i) => {
                    const style = FLAG_STYLES[flag.flagType] || FLAG_STYLES.AMBIGUOUS;
                    return (
                      <div key={i} className={`p-3 rounded-lg border ${style.border} ${style.bg}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${style.text} ${style.bg} border ${style.border}`}>
                            {flag.flagType}
                          </span>
                          <span className="text-xs text-slate-500">{flag.location}</span>
                        </div>
                        <p className="text-sm text-slate-800">{flag.issue}</p>
                        <p className="text-xs text-slate-500 mt-1">Fix: {flag.suggestedFix}</p>
                      </div>
                    );
                  })}
                </div>
              )
            ) : (
              <p className="text-card-muted text-sm text-center py-8 italic">
                {step === 'scanning' ? 'Scanning for risk flags...' : 'Run Risk Scan after drafting'}
              </p>
            )}
          </Card>
        </div>
      </div>

      {/* Protocol info bar */}
      <div className="bg-chrome-surface border border-chrome-border rounded-xl p-4 flex flex-wrap gap-x-8 gap-y-2 text-xs text-chrome-muted">
        <span>Max clarifying questions: <strong className="text-chrome-text">3</strong></span>
        <span>Draft limit: <strong className="text-chrome-text">&lt;250 words</strong></span>
        <span>Tags: <strong className="text-emerald-400">[GIVEN]</strong> <strong className="text-amber-400">[DERIVED]</strong> <strong className="text-red-400">[UNKNOWN]</strong></span>
        <span>Hallucinated entries: <strong className="text-red-400">0</strong></span>
        <span>Case: <strong className="text-chrome-text">{caseNumber}</strong></span>
      </div>
    </div>
  );
}
