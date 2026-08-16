-- ============================================================================
-- 0002_drop-unused-tables.sql — remove the orphaned auxiliary schema
--
-- 0001 provisioned users / user_settings / api_keys / quota_accounts /
-- share_links, but no dashboard code ever read or wrote them: the auxiliary
-- server only needs the Postgres ping behind /internal/health (no tables),
-- and browser error logs live in sqlite (data/logs.db). Worse, these names
-- collide with daemon tables of a different shape in the same Postgres
-- cluster, so a mispointed CARTETHYIA_DASHBOARD_DATABASE_URL could corrupt
-- the daemon database.
--
-- After this migration the aux database holds only schema_migrations.
-- ============================================================================

DROP TABLE IF EXISTS share_links    CASCADE;
DROP TABLE IF EXISTS quota_accounts CASCADE;
DROP TABLE IF EXISTS api_keys       CASCADE;
DROP TABLE IF EXISTS user_settings  CASCADE;
DROP TABLE IF EXISTS users          CASCADE;
