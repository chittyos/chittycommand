---
uri: chittycanon://docs/ops/summary/chittycommand
namespace: chittycanon://docs/ops
type: summary
version: 1.0.0
status: DRAFT
registered_with: chittycanon://core/services/canon
title: "ChittyCommand"
visibility: PUBLIC
---

# ChittyCommand

> `chittycanon://core/services/chittycommand` | Tier 5 (Application) | command.chitty.cc

## What It Does

Unified life management dashboard that ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

## How It Works

Cloudflare Worker at command.chitty.cc with Neon PostgreSQL via Hyperdrive, R2 for document storage, and KV for sync state. Cron-triggered data ingestion from Mercury, Plaid, ChittyFinance, ChittyScrape, and more. React SPA frontend at app.command.chitty.cc. MCP server for Claude-driven queries.
