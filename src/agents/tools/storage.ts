import { tool } from 'ai';
import { z } from 'zod';

const STORAGE_MCP_URL = 'https://storage.chitty.cc/mcp';

/**
 * Call a ChittyStorage MCP tool via JSON-RPC 2.0 over HTTP.
 */
async function callStorageMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(STORAGE_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: crypto.randomUUID(),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(unreadable)');
    throw new Error(`ChittyStorage MCP error ${res.status}: ${text}`);
  }

  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`ChittyStorage tool error: ${json.error.message}`);
  }
  return json.result;
}

/**
 * Create ChittyStorage tools that proxy to storage.chitty.cc MCP endpoint.
 */
export function createStorageTools() {
  return {
    search_documents: tool({
      description: 'Search documents in ChittyStorage by entity, filename, or content hash. Returns matching documents with metadata.',
      inputSchema: z.object({
        query: z.string().describe('Search query — entity slug, filename, or SHA-256 hash'),
        entity: z.string().optional().describe('Filter by entity slug (e.g., "arias-v-bianchi")'),
        limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
      }),
      execute: async ({ query, entity, limit }) => {
        return callStorageMcp('storage_search', {
          query,
          ...(entity && { entity }),
          ...(limit && { limit }),
        });
      },
    }),

    classify_document: tool({
      description: 'Use AI to classify and extract facts from a document in ChittyStorage. Identifies document type, key dates, amounts, and entities.',
      inputSchema: z.object({
        hash: z.string().describe('SHA-256 content hash of the document to classify'),
      }),
      execute: async ({ hash }) => {
        return callStorageMcp('storage_classify', { hash });
      },
    }),

    list_entity_documents: tool({
      description: 'List all documents stored for a specific entity.',
      inputSchema: z.object({
        entity: z.string().describe('Entity slug (e.g., "arias-v-bianchi", "it-can-be-llc")'),
      }),
      execute: async ({ entity }) => {
        return callStorageMcp('storage_entity', { entity });
      },
    }),

    ingest_document: tool({
      description: 'Ingest a new document into ChittyStorage. This is a WRITE operation — hashes the file, stores in R2, indexes in the database, and links to entities.',
      inputSchema: z.object({
        url: z.string().url().describe('URL of the document to ingest'),
        entity: z.string().describe('Entity slug to associate the document with'),
        filename: z.string().optional().describe('Override filename'),
      }),
      execute: async ({ url, entity, filename }) => {
        return callStorageMcp('storage_ingest', {
          url,
          entity,
          ...(filename && { filename }),
        });
      },
    }),
  };
}
