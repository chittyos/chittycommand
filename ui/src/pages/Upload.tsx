import { useState, useCallback, useEffect } from 'react';
import { api, type BatchUploadResult, type GapsResult } from '../lib/api';
import { formatDate } from '../lib/utils';

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
    api.getDocumentGaps().then(setGaps).catch(() => {});
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
    } catch (e: any) {
      setFiles((prev) => prev.map((f) => f.status === 'uploading' ? { ...f, status: 'error', error: e.message } : f));
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
        <h1 className="text-2xl font-bold text-white">Upload Documents</h1>
        {files.length > 0 && (
          <div className="flex gap-2">
            <button onClick={clearAll} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
              Clear All
            </button>
            <button
              onClick={handleUploadAll}
              disabled={uploading || !pendingCount}
              className="px-4 py-1.5 text-sm bg-chitty-600 text-white rounded hover:bg-chitty-700 disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Uploading...' : `Upload ${pendingCount} File${pendingCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>

      {/* Document coverage gaps */}
      {gaps && gaps.missing > 0 && (
        <div className="bg-yellow-900/20 border border-yellow-700 rounded-lg p-4">
          <h2 className="text-yellow-400 font-semibold text-sm mb-2">
            Missing Documents ({gaps.missing}/{gaps.total_payees} payees)
          </h2>
          <div className="flex flex-wrap gap-2">
            {gaps.gaps.filter((g) => !g.has_document).map((g) => (
              <span key={g.payee} className="px-2 py-1 text-xs rounded bg-yellow-900/40 text-yellow-300 border border-yellow-800">
                {g.payee} ({g.category})
              </span>
            ))}
          </div>
          <p className="text-yellow-600 text-xs mt-2">
            Upload statements for these payees to improve coverage
          </p>
        </div>
      )}

      {gaps && gaps.missing === 0 && gaps.total_payees > 0 && (
        <div className="bg-green-900/20 border border-green-700 rounded-lg p-3 text-green-400 text-sm">
          All {gaps.total_payees} active payees have at least one document on file
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
          dragOver ? 'border-chitty-500 bg-chitty-900/20' : 'border-gray-700 bg-[#161822]'
        }`}
      >
        <p className="text-gray-400 text-lg">
          Drop bills, statements, or documents here
        </p>
        <p className="text-gray-600 text-sm mt-2">PDF, PNG, JPG, WebP, CSV, TXT — up to 25MB each, 20 files per batch</p>
        <p className="text-gray-600 text-xs mt-1">Duplicates are automatically skipped</p>
        <label className="inline-block mt-4 px-4 py-2 bg-chitty-600 text-white rounded cursor-pointer hover:bg-chitty-700">
          Browse Files
          <input type="file" className="hidden" onChange={handleFileInput} accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt" multiple />
        </label>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">Files ({files.length})</h2>
          <div className="space-y-2">
            {files.map((entry, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                <div className="flex items-center gap-3 min-w-0">
                  <StatusIcon status={entry.status} />
                  <div className="min-w-0">
                    <p className="text-white text-sm truncate">{entry.file.name}</p>
                    <p className="text-gray-500 text-xs">{formatSize(entry.file.size)} — {entry.file.type || 'unknown type'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {entry.status === 'skipped' && <span className="text-yellow-400 text-xs">Duplicate</span>}
                  {entry.error && entry.status === 'error' && <span className="text-red-400 text-xs max-w-48 truncate">{entry.error}</span>}
                  {(entry.status === 'pending' || entry.status === 'error') && (
                    <button onClick={() => removeFile(i)} className="text-gray-500 hover:text-red-400 text-sm px-1">
                      &times;
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Batch result summary */}
      {batchResult && (
        <div className={`p-3 rounded text-sm ${batchResult.failed > 0 ? 'bg-yellow-900/30 text-yellow-400' : 'bg-green-900/30 text-green-400'}`}>
          Uploaded {batchResult.succeeded}/{batchResult.total} files
          {batchResult.skipped > 0 ? ` (${batchResult.skipped} skipped as duplicates)` : ''}
          {batchResult.failed > 0 ? ` (${batchResult.failed} failed)` : ''}
        </div>
      )}

      {/* Coverage table */}
      {gaps && gaps.total_payees > 0 && (
        <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
          <h2 className="text-white font-semibold mb-3">Document Coverage</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2">Payee</th>
                <th className="text-left py-2">Category</th>
                <th className="text-left py-2">Frequency</th>
                <th className="text-left py-2">Last Upload</th>
                <th className="text-left py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {gaps.gaps.map((g) => (
                <tr key={g.payee} className="border-b border-gray-800 last:border-0">
                  <td className="py-2 text-white">{g.payee}</td>
                  <td className="py-2 text-gray-400">{g.category}</td>
                  <td className="py-2 text-gray-400">{g.recurrence || '—'}</td>
                  <td className="py-2 text-gray-400">{g.last_upload ? formatDate(g.last_upload) : '—'}</td>
                  <td className="py-2">
                    {g.has_document
                      ? <span className="text-xs px-1.5 py-0.5 rounded bg-green-600 text-white">Covered</span>
                      : <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-600 text-white">Missing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-[#161822] rounded-lg border border-gray-800 p-4">
        <h2 className="text-white font-semibold mb-2">Email Forwarding</h2>
        <p className="text-gray-400 text-sm">
          Forward bill emails to <code className="bg-gray-800 px-1.5 py-0.5 rounded text-chitty-500">bills@command.chitty.cc</code> for automatic parsing.
        </p>
        <p className="text-gray-500 text-xs mt-2">
          Supported: ComEd, Peoples Gas, Xfinity, Citi, Home Depot, Lowe's statements
        </p>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: FileEntry['status'] }) {
  switch (status) {
    case 'pending': return <div className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />;
    case 'uploading': return <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />;
    case 'done': return <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
    case 'skipped': return <div className="w-2 h-2 rounded-full bg-yellow-500 shrink-0" />;
    case 'error': return <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
