-- pg_cron runs the retention jobs of 20261108130000_letterboxd_request_log
-- and 20261108140000_letterboxd_queue. It is installed here, before the
-- rename of 20261006120000_accounts_providers_connections, so that a
-- production database that cannot install it stops the release before any
-- table changes. The deploy plan also checks that production can install
-- every extension that a pending migration creates.
CREATE EXTENSION IF NOT EXISTS pg_cron;
