-- 002_ingress_host.sql
-- Record which public hostname each contribution arrived on, so a domain
-- migration can be drained safely: the dashboard can show how many contributors
-- still ride the legacy *.workers.dev host before it is retired. Nullable and
-- additive — pre-existing rows keep NULL, and the contribute hot path only gains
-- one bound column value (no extra query).

ALTER TABLE contribution ADD COLUMN ingress_host TEXT;
