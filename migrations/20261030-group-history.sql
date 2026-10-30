CREATE TABLE IF NOT EXISTS group_history_control (
  singleton boolean PRIMARY KEY CHECK(singleton),
  generation bigint NOT NULL,
  config_key text NOT NULL
);
-- Apply manually in an approved maintenance window. Feature remains disabled.
CREATE TABLE IF NOT EXISTS group_history_policy (
  scope text PRIMARY KEY,
  revision text NOT NULL,
  restore_epoch text NOT NULL,
  enabled_at timestamptz NOT NULL,
  floor_at timestamptz NOT NULL DEFAULT '1970-01-01',
  enabled boolean NOT NULL DEFAULT false,
  gap boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS group_history_message (
  scope text NOT NULL REFERENCES group_history_policy(scope),
  message_key text NOT NULL,
  requester_key text NOT NULL,
  revision text NOT NULL,
  restore_epoch text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  quoted_key text,
  body text,
  human boolean NOT NULL DEFAULT true,
  dependencies jsonb,
  withdrawn boolean NOT NULL DEFAULT false,
  PRIMARY KEY(scope,message_key)
);
CREATE INDEX IF NOT EXISTS group_history_time ON group_history_message(scope,occurred_at,message_key);
CREATE INDEX IF NOT EXISTS group_history_expiry ON group_history_message(expires_at);
CREATE INDEX IF NOT EXISTS group_history_oldest ON group_history_message(received_at);

CREATE INDEX IF NOT EXISTS group_history_quote ON group_history_message(scope,quoted_key,occurred_at);
