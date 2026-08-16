-- Separate database for the dashboard auxiliary server.
-- Its schema is migration bookkeeping only (schema_migrations; the orphaned
-- 0001 tables were dropped by 0002), but keeping it separate means the aux
-- /internal/health pinger and its migration state never share the daemon's
-- cartethyia database. Runs once on first boot of the postgres volume.
CREATE DATABASE cartethyia_dashboard;
