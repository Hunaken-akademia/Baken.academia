CREATE SCHEMA IF NOT EXISTS api_security;
REVOKE ALL ON SCHEMA api_security FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA api_security TO service_role;

CREATE TABLE IF NOT EXISTS api_security.request_budgets (
  application text NOT NULL CHECK (application IN ('wake','rein')),
  bucket text NOT NULL CHECK (bucket IN ('predict','read','write','login','internal')),
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  used integer NOT NULL CHECK (used >= 0),
  last_granted integer NOT NULL CHECK (last_granted BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (application, bucket, identity_hash)
);
CREATE INDEX IF NOT EXISTS request_budgets_expiry_idx ON api_security.request_budgets (expires_at);
ALTER TABLE api_security.request_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON api_security.request_budgets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_security.request_budgets TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_api_budget_v1(
  p_application text, p_bucket text, p_identity text, p_take integer DEFAULT 5
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_end timestamptz;
  v_limit integer;
  v_granted integer;
  v_used integer;
BEGIN
  IF p_application NOT IN ('wake','rein') OR p_application IS NULL
    OR p_bucket NOT IN ('predict','read','write','login','internal') OR p_bucket IS NULL
    OR p_identity IS NULL OR p_identity !~ '^[0-9a-f]{64}$'
    OR p_take IS NULL OR p_take < 1 OR p_take > 5 THEN
    RAISE EXCEPTION 'Invalid API budget parameters' USING ERRCODE = '22023';
  END IF;
  v_limit := CASE p_bucket WHEN 'predict' THEN 120 WHEN 'write' THEN 60
    WHEN 'login' THEN 30 WHEN 'internal' THEN 120
    ELSE CASE p_application WHEN 'wake' THEN 600 ELSE 240 END END;
  v_end := to_timestamp((floor(extract(epoch FROM v_now) / 60) + 1) * 60);
  INSERT INTO api_security.request_budgets AS current
    (application,bucket,identity_hash,used,last_granted,expires_at)
  VALUES (p_application,p_bucket,p_identity,p_take,p_take,v_end)
  ON CONFLICT (application,bucket,identity_hash) DO UPDATE SET
    last_granted = CASE WHEN current.expires_at <= v_now THEN p_take
      ELSE greatest(0,least(p_take,v_limit-current.used)) END,
    used = CASE WHEN current.expires_at <= v_now THEN p_take
      ELSE least(v_limit,current.used+p_take) END,
    expires_at = greatest(current.expires_at,v_end)
  RETURNING last_granted,used,expires_at INTO v_granted,v_used,v_end;
  -- Bounded cleanup uses the expiry index. There is no cron or paid dependency;
  -- expired hashes are removed on subsequent traffic after one hour of inactivity.
  DELETE FROM api_security.request_budgets WHERE ctid IN (
    SELECT ctid FROM api_security.request_budgets
    WHERE expires_at < v_now - interval '1 hour' ORDER BY expires_at LIMIT 20
    FOR UPDATE SKIP LOCKED
  );
  RETURN jsonb_build_object('granted',v_granted,'remaining',v_limit-v_used,
    'limit',v_limit,'reset_at_ms',floor(extract(epoch FROM v_end)*1000));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_api_budget_v1(text,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_api_budget_v1(text,text,text,integer) TO service_role;
COMMENT ON FUNCTION public.reserve_api_budget_v1(text,text,text,integer) IS
  'Server-only atomic request leases for WAKE and REIN. Limits do not depend on caller input.';
NOTIFY pgrst, 'reload schema';
