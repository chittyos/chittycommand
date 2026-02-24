# ChittyCommand UI Overhaul — "Command Console"

**Date:** 2026-02-23
**Status:** Approved
**Canonical URI:** `chittycanon://core/services/chittycommand#ui-overhaul`

## Design Direction

Hybrid of Bloomberg Terminal (information density, real-time data flow) and Apple Finance (clean cards, quality typography, refined aesthetics). Designed ADHD/neurospicy-first.

## Visual Language

### Color Scheme: Dark Chrome + Light Cards
- **Shell** (sidebar, nav, status bar): Dark background (`#1a1a2e` → `#16213e` range)
- **Card surfaces**: White/near-white (`#ffffff` / `#fafafa`)
- **Urgency accents**: Red (`#ef4444`), Amber (`#f59e0b`), Green (`#22c55e`)
- **Text**: Dark on light cards, light on dark chrome
- **Muted state**: Low-urgency cards use lighter text (`#9ca3af`), no border accent

### Typography
- **Display/headings**: Outfit (geometric sans-serif) — clean, modern, highly legible
- **Body/data**: Outfit at smaller weights — consistent family, no font-switching fatigue
- **Monospace (numbers/amounts)**: JetBrains Mono or Tabular Outfit — aligned columns for financial data

### Spatial Rules
- Cards have generous internal padding but tight grid gaps — dense layout, breathable cards
- Consistent card anatomy: title → key metric → status indicator → primary action
- Left-border color accent for urgency (4px solid)
- Rounded corners (8-12px) on all cards — Apple softness

## Layout Architecture

### Widget-Based Grid
- CSS Grid dashboard with named areas
- Draggable, resizable panels (saved to user preferences in KV)
- Auto-personalizes: highest-urgency widgets float to top-left
- Responsive: collapses to single-column on mobile

### Sections
1. **Top status bar** — cash position, next due date, sync freshness dots (green/amber/red), Focus Mode toggle
2. **Sidebar** (dark) — navigation, account summary, quick filters
3. **Main grid** — widget cards:
   - Obligations (bills due, sorted by urgency)
   - Active disputes (progress bars, status, next action)
   - Cashflow chart (30-day projection)
   - Recommendations (AI-scored, one CTA each)
   - Recent transactions (last 10, grouped by account)
   - Upcoming deadlines (calendar-style, next 14 days)
   - Sync status (per-source freshness, last run time)

## ADHD/Neurospicy-First Principles

### 1. Focus Mode (default: ON)
- Landing view shows only top 3 most urgent items
- Each item: what it is, why it's urgent, one action button
- "See everything" toggle expands to full dense dashboard
- Reduces cognitive load on every visit — no overwhelm on load

### 2. Visual Hierarchy Does the Thinking
- Urgency scoring auto-sorts all widgets and items within widgets
- Most important = biggest, brightest, top-left position
- No scanning or deciding "what should I look at first"

### 3. One Clear Action Per Card
- Single primary CTA button per card (pay, respond, review)
- Secondary actions behind a "..." menu
- No decision paralysis from multiple equal-weight options

### 4. Color-Coded Urgency Borders
- Red (4px left border): overdue or due within 48hrs
- Amber: due within 7 days or needs attention
- Green: on track, no action needed
- Peripheral vision catches urgency without reading

### 5. Progress Indicators Everywhere
- Disputes: progress bar (filed → response → resolution)
- Monthly bills: "3 of 7 paid" with filled dots
- Sync cycles: completion indicators per source
- Dopamine-friendly — visible forward motion

### 6. Chunked Sections with Clear Labels
- Bold section headers, clear card boundaries
- No wall-of-data — every group is visually separated
- Consistent card anatomy reduces cognitive parsing

### 7. Muted Non-Urgent Items
- Low-urgency cards: lighter text, no accent border, smaller font
- High-urgency: full color, accent border, larger metric
- Attention goes where it's needed without effort

### 8. Persistent Widget Layout
- Drag to reorder, collapse/expand — arrangement saved
- Same layout every visit — no re-orienting
- Layout stored in Cloudflare KV per user

## Subtle Data Indicators (Not Animations)

- **Freshness dots**: small colored circles (green=fresh, amber=stale, red=failed) next to each data source
- **Delta arrows**: small up/down arrows on amounts showing change from last sync
- **Muted timestamps**: "2h ago" in light gray under each card
- No pulse effects, no ticker strips, no glow — data confidence without noise

## Tech Stack

- **Framework**: React (existing) + Shadcn UI components
- **Styling**: Tailwind CSS with CSS custom properties for theming
- **Grid**: CSS Grid with `react-grid-layout` for drag/resize
- **Charts**: Recharts (lightweight, React-native)
- **State**: React context + Cloudflare KV for layout persistence
- **Build**: Vite → Cloudflare Pages

## Not Included

- Ticker strips / scrolling tapes
- Scan-line or CRT effects
- Heavy animations or glow effects
- Sound effects or haptics
- Multiple theme options (single cohesive theme)
