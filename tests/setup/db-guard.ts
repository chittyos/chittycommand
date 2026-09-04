/**
 * Test-database guard.
 *
 * This suite applies DDL migrations and executes 40+ write statements against
 * whatever connection string it is handed. It used to take that string from the
 * ambient `DATABASE_URL`, which on a developer machine is routinely a live
 * production database — so a bare `npx vitest run` could migrate production
 * before a single test executed.
 *
 * Precedent: a sibling repo's suite sourced an ambient production connection
 * string and, combined with a live fetch pass-through, wrote 71 synthetic rows
 * into a production table. Same class of footgun, larger blast radius here —
 * DDL rather than inserts.
 *
 * Two controls, in order:
 *
 *  1. Opt-in, fail-closed. The suite reads NEON_TEST_DATABASE_URL and nothing
 *     else. Ambient DATABASE_URL is ignored and actively cleared (see
 *     env-guard.ts), so it cannot leak in through the specs that read
 *     `process.env.DATABASE_URL` directly. Unset means "skip the integration
 *     tests", never "use whatever happens to be exported".
 *
 *  2. Denylist, defense in depth — catches a deliberate paste of the wrong
 *     string into the opt-in variable. Endpoints are stored as SHA-256 digests
 *     rather than plaintext because this repo is public, and a labelled
 *     inventory of an organisation's live database hostnames is not something
 *     to publish. A digest is exact-match checkable without disclosing the id.
 *
 * To add an endpoint:  node -e "console.log(require('crypto').createHash('sha256').update('ep-...').digest('hex'))"
 */
import { createHash } from 'node:crypto';

/** SHA-256 of each known production Neon endpoint id. Sorted; unlabelled by design. */
const PRODUCTION_ENDPOINT_DIGESTS = new Set([
  '0cdaebbe5bef09c528d20809776871ce5f6b191dfa39241ca43a9ec1c2846879',
  '151772cd1ce9a5b740d8ccd24547d9e09bff4996b1818702bd33beeb7fee86be',
  '169227abfeb7e139073ec0d058f72345329b22f2450b55babf7aa5169c82cf3d',
  '180b4d3320bc3a6212629fa90a454ac5ee0d21c1815a13bd2f3ed8fdcd7eabc4',
  '1c828465dd0fcac8c09b3302656d94ad8789428487d01d4f54b578432bfa5e11',
  '3485b9f738400b3092b4e7c279a054a5c9ca25c81cdcb5c0f5a97118c6965a76',
  '4095270f4d888cba4b109a21b181661693abb2821591dd5bac73906b1c884d8e',
  '4bf8f89ceb00cf3b66ecebe3a65346302a587a162438ae6595d19369eb78f68b',
  '59ae026795f7c79b26a6228a400c3c9cdfdd9fcf5864372b9fe090fc18db599e',
  '649e660e787c4d2e2f7f6c38bf9a143a8cb34c904db48dc64fd34553d5c92ee6',
  '67f1427362150b066440e988fbcf2477c22c37dc73df7081c9beb0800bc22c61',
  '6d7b51aa1cd0516af8f034e29bdd68498ba748fbed06c11889fa89ed5976fb74',
  '8bd9bf5ee7e02612356ac178ea2352929db3479bdea33b678f15a2782dd6dec1',
  '922d195e9e7962000b114008242b587dc7140594b82da02fbe2d7e43f8df77cc',
  'ae646130ae237529535529a0dbe0ff761a7f3a1b92f4632f1f6a76c95e9bfcf1',
  'b816c80f1ab7631b9df3320f1b16df3d0a1878c557b8628d3ad383f4549ef63e',
  'bfde156574815b5e71d0ab7dc5f4c6c353baa7b1909d74ec24e256387f64c33b',
  'c6454145dc0843284fabfb2322d84a28d212439570f67b06b9a63af14afef782',
  'e0a0b3ce8defb97c6287ca393428660c63b53c2fe5a9461c5212001a5cffaef8',
  'ea7e872d0a9a43de188f883de5ef6e5276739fc4d1d0c7b00c8e677ba6fe287d',
  'f120cf44a7c2af54635f7c5e7a6bf9a7aa655d03ecacfde494343111f9162262',
]);

/** Neon endpoint ids are `ep-<word>-<word>-<suffix>`, optionally followed by `-pooler`. */
const NEON_ENDPOINT_RE = /\bep-[a-z]+-[a-z]+-[a-z0-9]+/g;

export function assertNotProduction(
  connectionString: string,
  varName = 'NEON_TEST_DATABASE_URL',
): void {
  for (const endpoint of connectionString.match(NEON_ENDPOINT_RE) ?? []) {
    const digest = createHash('sha256').update(endpoint).digest('hex');
    if (PRODUCTION_ENDPOINT_DIGESTS.has(digest)) {
      throw new Error(
        `${varName} points at a known production Neon endpoint ("${endpoint}"). ` +
          `This suite applies migrations and writes rows — refusing to run. ` +
          `Use a disposable Neon branch.`,
      );
    }
  }
}

/**
 * The single source of the suite's database URL. Returns undefined when the
 * opt-in variable is unset, which every caller treats as "skip integration".
 */
export function resolveTestDatabaseUrl(): string | undefined {
  const url = process.env.NEON_TEST_DATABASE_URL;
  if (!url) return undefined;
  assertNotProduction(url);
  return url;
}
