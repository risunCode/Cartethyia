-- Separate database for the dashboard auxiliary server.
-- Its migrations create users/api_keys/share_links tables whose names collide
-- with the daemon schema, so sharing the cartethyia database would corrupt
-- both. Runs once on first boot of the postgres volume.
CREATE DATABASE cartethyia_dashboard;
