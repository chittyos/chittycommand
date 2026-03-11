# Notion Task Triager — ChittyCommand Dispute Integration

Add the following to the Task Triager agent's instructions in Notion Settings > Connections > Task Triager > Edit instructions.

---

## Dispute & Legal Task Classification

When you receive an email or message related to any of the following topics, classify it as a **legal task** so it automatically syncs into ChittyCommand's dispute tracker:

- Disputes with vendors, landlords, tenants, contractors, or counterparties
- Insurance claims or denials
- Court filings, summons, motions, or docket updates
- Property damage, water damage, or maintenance disputes
- Legal deadlines, statute of limitations, or response due dates
- Demand letters, cease & desist, or settlement offers
- Payment disputes, chargebacks, or billing errors
- Government notices (IRS, county, city violations)

### Required Properties for Legal Tasks

When creating a task page in the **Business Task Tracker** database for dispute/legal items:

| Property | Value | Notes |
|----------|-------|-------|
| **Title** | Clear, descriptive title | e.g. "Water damage claim — 123 Main St — Allstate denial" |
| **Type** | `Legal` | MUST be "Legal" for ChittyCommand to pick it up as a dispute |
| **Source** | `Email` | Use "Email" for email-ingested items, "Mention" for @-mentions |
| **Priority 1** | 1-10 (number) | 1 = most urgent. Use 1-3 for court deadlines, 4-6 for active disputes, 7-10 for monitoring |
| **Tags** | One or more from the list below | Helps categorize the dispute type |
| **Description** | Summarize the key facts | Include: who, what, amounts, dates, and any deadlines mentioned |
| **Due Date** | Set if there's an explicit deadline | Court dates, response deadlines, filing windows |

### Tag Guidelines

Apply one or more of these tags based on the content:

- `Dispute` — General disputes with any counterparty
- `Insurance-claim` — Insurance claims, denials, appeals
- `Court-filing` — Court documents, motions, hearings, docket activity
- `Property-issue` — Property damage, maintenance, HOA issues
- `Vendor-dispute` — Contractor, vendor, or service provider disputes
- `Legal-deadline` — Time-sensitive legal obligations
- `Payment` — Payment disputes, chargebacks, billing errors
- `Tax` — IRS notices, property tax disputes, assessments
- `Utility` — Utility billing disputes (ComEd, Peoples Gas, etc.)

### Priority Guidance

| Priority | Use When |
|----------|----------|
| 1-2 | Court deadline within 7 days, active hearing, imminent statute expiry |
| 3-4 | Response needed within 30 days, active negotiations, pending insurance decision |
| 5-6 | Monitoring active disputes, follow-up needed, no immediate deadline |
| 7-8 | Informational notices, early-stage inquiries, low-stakes items |
| 9-10 | Archive-worthy, resolved but tracking, general awareness |

### What Happens After Creation

Once you create a legal task in the Business Task Tracker:

1. **ChittyCommand's daily cron** (6 AM CT) syncs new legal tasks into `cc_disputes`
2. **TriageAgent** automatically scores the dispute for severity and priority
3. **ChittyLedger** creates a case record for chain-of-custody tracking
4. The dispute appears in the ChittyCommand dashboard for action tracking

You do NOT need to create anything in ChittyCommand directly — the sync is automatic.

### Examples

**Email**: "Allstate denied claim #CLM-2024-8847 for water damage at 4521 S Drexel..."
→ Type: `Legal` | Priority 1: `3` | Tags: `Insurance-claim`, `Property-issue` | Due Date: appeal deadline if mentioned

**Email**: "Cook County Circuit Court — Notice of hearing, Case 2024D007847, March 15..."
→ Type: `Legal` | Priority 1: `1` | Tags: `Court-filing`, `Legal-deadline` | Due Date: `2026-03-15`

**Email**: "Mr. Cooper mortgage — escrow shortage notice, payment increase effective..."
→ Type: `Legal` | Priority 1: `5` | Tags: `Payment`, `Property-issue` | Due Date: effective date
