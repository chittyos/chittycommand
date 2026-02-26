-- Email account connections (per-user, multi-account)
CREATE TABLE cc_email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email_address TEXT NOT NULL,
  display_name TEXT,
  connect_ref TEXT,
  namespace TEXT,
  status TEXT DEFAULT 'pending',
  last_synced_at TIMESTAMPTZ,
  error_message TEXT,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_cc_email_conn_email_user ON cc_email_connections(email_address, user_id);
CREATE INDEX idx_cc_email_conn_user ON cc_email_connections(user_id);
CREATE INDEX idx_cc_email_conn_namespace ON cc_email_connections(namespace);

-- User namespace mapping (nick -> nick@chitty.cc)
CREATE TABLE cc_user_namespaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
