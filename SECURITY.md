# SECURITY.md - chittycommand Security Policy

## Authentication & Authorization
- **Auth Provider**: `chittyauth` (OAuth 2.0 PKCE / Service Tokens)
- **Token Verification**: Cloudflare Zero Trust Access & JWT Signatures

## Secret Scopes & Governance
- Secrets managed via Cloudflare Workers Secret Store / `chico-keys`.
- Direct secret committing in repository is strictly prohibited.
