import { useState, useCallback, useEffect } from 'react';
import { api, type BatchUploadResult, type GapsResult } from '../lib/api';
import { formatDate } from '../lib/utils';
import { Card } from '../components/ui/Card';
import { ActionButton } from '../components/ui/ActionButton';

interface FileEntry {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'skipped' | 'error';
  error?: string;
}

export function Upload() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchUploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [gaps, setGaps] = useState<GapsResult | null>(null);

  useEffect(() => {
    api.getDocumentGaps().then(setGaps).catch((e) => console.error('[Upload] document gaps failed:', e));
  }, [batchResult]);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const entries: FileEntry[] = Array.from(newFiles).map((file) => ({ file, status: 'pending' }));
    setFiles((prev) => [...prev, ...entries]);
    setBatchResult(null);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAll = useCallback(() => {
    setFiles([]);
    setBatchResult(null);
  }, []);

  const handleUploadAll = useCallback(async () => {
    const pending = files.filter((f) => f.status === 'pending' || f.status === 'error');
    if (!pending.length) return;

    setUploading(true);
    setBatchResult(null);
    setFiles((prev) => prev.map((f) => (f.status === 'pending' || f.status === 'error') ? { ...f, status: 'uploading' } : f));

    try {
      const result = await api.uploadBatch(pending.map((f) => f.file));
      setBatchResult(result);

      setFiles((prev) => prev.map((f) => {
        if (f.status !== 'uploading') return f;
        const match = result.results.find((r) => r.filename === f.file.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
        if (match?.status === 'ok') return { ...f, status: 'done' };
        if (match?.status === 'skipped') return { ...f, status: 'skipped', error: 'Duplicate — already uploaded' };
        if (match?.status === 'error') return { ...f, status: 'error', error: match.error };
        return { ...f, status: 'done' };
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'error', error: msg } : f));
    } finally {
      setUploading(false);
    }
  }, [files]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = '';
  }, [addFiles]);

  const pendingCount = files.filter((f) => f.status === 'pending' || f.status === 'error').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-chrome-text">Upload Documents</h1>
        {files.length > 0 && (
          <div className="flex gap-2">
            <button onClick={clearAll} className="px-3 py-1.5 text-sm text-chrome-muted hover:text-chrome-text transition-colors">
              Clear All
            </button>
            <ActionButton
              label={uploading ? 'Uploading...' : `Upload ${pendingCount} File${pendingCount !== 1 ? 's' : ''}`}
              onClick={handleUploadAll}
              loading={uploading}
              disabled={!pendingCount}
            />
          </div>
        )}
      </div>

      {/* Document coverage gaps */}
      {gaps && gaps.missing > 0 && (
        <Card urgency="amber">
          <h2 className="text-urgency-amber font-semibold text-sm mb-2">
            Missing Documents ({gaps.missing}/{gaps.total_payees} payees)
          </h2>
          <div className="flex flex-wrap gap-2">
            {gaps.gaps.filter((g) => !g.has_document).map((g) => (
              <span key={g.payee} className="px-2 py-1 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                {g.payee} ({g.category})
              </span>
            ))}
          </div>
          <p className="text-card-muted text-xs mt-2">
            Upload statements for these payees to improve coverage
          </p>
        </Card>
      )}

      {gaps && gaps.missing === 0 && gaps.total_payees > 0 && (
        <Card urgency="green">
          <p className="text-urgency-green text-sm">
            All {gaps.total_payees} active payees have at least one document on file
          </p>
        </Card>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-card p-12 text-center transition-colors ${
          dragOver ? 'border-chitty-500 bg-chitty-50' : 'border-card-border bg-card-bg'
        }`}
      >
        <p className="text-card-text text-lg">
          Drop bills, statements, or documents here
        </p>
        <p className="text-card-muted text-sm mt-2">PDF, PNG, JPG, WebP, CSV, TXT -- up to 25MB each, 20 files per batch</p>
        <p className="text-card-muted text-xs mt-1">Duplicates are automatically skipped</p>
        <label className="inline-block mt-4 px-4 py-2 bg-chitty-600 text-white rounded-lg cursor-pointer hover:bg-chitty-700 transition-colors font-medium text-sm">
          Browse Files
          <input type="file" className="hidden" onChange={handleFileInput} accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt" multiple />
        </label>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <Card>
          <h2 className="text-card-text font-semibold mb-3">Files ({files.length})</h2>
          <div className="space-y-2">
            {files.map((entry, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-card-border last:border-0">
                <div className="flex items-center gap-3 min-w-0">
                  <StatusIcon status={entry.status} />
                  <div className="min-w-0">
                    <p className="text-card-text text-sm truncate">{entry.file.name}</p>
                    <p className="text-card-muted text-xs">{formatSize(entry.file.size)} -- {entry.file.type || 'unknown type'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {entry.status === 'skipped' && <span className="text-urgency-amber text-xs">Duplicate</span>}
                  {entry.error && entry.status === 'error' && <span className="text-urgency-red text-xs max-w-48 truncate">{entry.error}</span>}
                  {(entry.status === 'pending' || entry.status === 'error') && (
                    <button onClick={() => removeFile(i)} className="text-card-muted hover:text-urgency-red text-sm px-1">
                      &times;
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Batch result summary */}
      {batchResult && (
        <Card urgency={batchResult.failed > 0 ? 'amber' : 'green'}>
          <p className={`text-sm ${batchResult.failed > 0 ? 'text-urgency-amber' : 'text-urgency-green'}`}>
            Uploaded {batchResult.succeeded}/{batchResult.total} files
            {batchResult.skipped > 0 ? ` (${batchResult.skipped} skipped as duplicates)` : ''}
            {batchResult.failed > 0 ? ` (${batchResult.failed} failed)` : ''}
          </p>
        </Card>
      )}

      {/* Coverage table */}
      {gaps && gaps.total_payees > 0 && (
        <Card>
          <h2 className="text-card-text font-semibold mb-3">Document Coverage</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-card-muted border-b border-card-border">
                <th className="text-left py-2">Payee</th>
                <th className="text-left py-2">Category</th>
                <th className="text-left py-2">Frequency</th>
                <th className="text-left py-2">Last Upload</th>
                <th className="text-left py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {gaps.gaps.map((g) => (
                <tr key={g.payee} className="border-b border-card-border last:border-0">
                  <td className="py-2 text-card-text">{g.payee}</td>
                  <td className="py-2 text-card-muted">{g.category}</td>
                  <td className="py-2 text-card-muted">{g.recurrence || '--'}</td>
                  <td className="py-2 text-card-muted">{g.last_upload ? formatDate(g.last_upload) : '--'}</td>
                  <td className="py-2">
                    {g.has_document
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Covered</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Missing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <h2 className="text-card-text font-semibold mb-2">Email Forwarding</h2>
        <p className="text-card-muted text-sm">
          Forward bill emails to <code className="bg-card-hover px-1.5 py-0.5 rounded text-chitty-600 font-mono text-xs">bills@command.chitty.cc</code> for automatic parsing.
        </p>
        <p className="text-card-muted text-xs mt-2">
          Supported: ComEd, Peoples Gas, Xfinity, Citi, Home Depot, Lowe's statements
        </p>
      </Card>
    </div>
  );
}

function StatusIcon({ status }: { status: FileEntry['status'] }) {
  switch (status) {
    case 'pending': return <div className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />;
    case 'uploading': return <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />;
    case 'done': return <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
    case 'skipped': return <div className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />;
    case 'error': return <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
