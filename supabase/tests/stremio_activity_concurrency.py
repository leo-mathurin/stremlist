import os
import selectors
import subprocess
import time
import unittest
import uuid


class PsqlSession:
    def __init__(self, name):
        self.process = subprocess.Popen(
            ["docker", "exec", "-i", "supabase_db_stremlist", "psql", "-XqAt", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.pending = ""
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.query(f"SET application_name = '{name}'")

    def start(self, sql):
        marker = "activity_done_" + uuid.uuid4().hex
        self.process.stdin.write((sql + ";\n\\echo " + marker + "\n").encode())
        self.process.stdin.flush()
        return marker

    def finish(self, marker):
        lines = []
        deadline = time.monotonic() + 15
        while True:
            if "\n" in self.pending:
                line, self.pending = self.pending.split("\n", 1)
                if line == marker:
                    return lines
                lines.append(line)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("Postgres session did not finish: " + "\n".join(lines))
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("Postgres session ended: " + "\n".join(lines))
            self.pending += chunk.decode()

    def query(self, sql):
        return self.finish(self.start(sql))

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=3)
        self.selector.close()
        self.process.stdout.close()


class ActivityConcurrency(unittest.TestCase):
    account = "sl_ActivityRace0000000001"

    def setUp(self):
        self.control = PsqlSession("activity-control-test")
        self.writer = PsqlSession("activity-writer-test")
        self.settings = PsqlSession("activity-settings-test")
        self.control.query(f"""
            INSERT INTO public.accounts(id) VALUES ('{self.account}');
            INSERT INTO public.connections(account_id,provider,provider_username,access_token,redirect_uri)
            VALUES ('{self.account}','simkl','fixture','sealed','http://127.0.0.1/callback');
            INSERT INTO public.watch_tracking(account_id,sweep_slot,baseline_at,consented_at)
            VALUES ('{self.account}',1,now(),now());
            INSERT INTO public.watch_destinations(account_id,provider,watched_enabled,watchlist_enabled)
            VALUES ('{self.account}','simkl',true,true)
        """)

    def tearDown(self):
        self.control.query("SELECT pg_advisory_unlock_all()")
        self.writer.close()
        self.settings.close()
        try:
            self.control.query(f"""
                DROP TRIGGER IF EXISTS __test_activity_insert_gate ON public.watch_writes;
                DROP FUNCTION IF EXISTS public.__test_activity_insert_gate();
                DELETE FROM public.accounts WHERE id='{self.account}'
            """)
        finally:
            self.control.close()

    def wait_for(self, condition):
        self.control.query(f"""
            DO $$ DECLARE deadline timestamptz := clock_timestamp() + interval '10 seconds';
            BEGIN LOOP
                PERFORM pg_stat_clear_snapshot();
                EXIT WHEN ({condition});
                IF clock_timestamp() > deadline THEN RAISE EXCEPTION 'database signal was not observed'; END IF;
                PERFORM pg_sleep(0.001);
            END LOOP; END $$
        """)

    def test_watched_opt_out_serializes_with_enqueue(self):
        self.control.query(f"""
            CREATE FUNCTION public.__test_activity_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(9141151); RETURN NEW; END; $$;
            CREATE TRIGGER __test_activity_insert_gate BEFORE INSERT ON public.watch_writes
            FOR EACH ROW WHEN (NEW.account_id = '{self.account}') EXECUTE FUNCTION public.__test_activity_insert_gate();
            SELECT pg_advisory_lock(9141151)
        """)
        writer = self.writer.start(f"""SELECT public.queue_watch_writes('[{{"account_id":"{self.account}","provider":"simkl","imdb_id":"tt0000001","item_type":"movie","watched_at":"2026-11-19T10:00:00Z"}}]'::jsonb)""")
        self.wait_for("EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='activity-writer-test' AND wait_event='advisory')")
        settings = self.settings.start(f"SELECT public.configure_watch_activity('{self.account}',ARRAY[]::text[],ARRAY['simkl'],false)")
        self.wait_for("EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='activity-settings-test' AND query LIKE 'SELECT public.configure_watch_activity(%' AND (state='idle' OR wait_event_type='Lock'))")
        self.control.query("SELECT pg_advisory_unlock(9141151)")
        self.writer.finish(writer)
        self.settings.finish(settings)
        self.assertEqual(self.control.query(f"SELECT count(*) FROM public.watch_writes WHERE account_id='{self.account}' AND kind='watched'"), ["0"])
        self.assertEqual(self.control.query(f"SELECT NOT watched_enabled AND watchlist_enabled FROM public.watch_destinations WHERE account_id='{self.account}'"), ["t"])

    def test_simkl_writes_exclude_other_workers_for_the_same_title(self):
        first, other = str(uuid.uuid4()), str(uuid.uuid4())
        claim = lambda token, title="tt0000001": f"SELECT public.claim_simkl_write('{self.account}','{title}','{token}')"
        self.assertEqual(self.writer.query(claim(first)), ["t"])
        self.assertEqual(self.settings.query(claim(other)), ["f"])
        self.assertEqual(self.settings.query(claim(other, "tt0000002")), ["t"])
        self.settings.query(f"SELECT public.release_simkl_write('{self.account}','tt0000001','{other}')")
        self.assertEqual(self.settings.query(claim(other)), ["f"])
        self.writer.query(f"SELECT public.release_simkl_write('{self.account}','tt0000001','{first}')")
        self.assertEqual(self.settings.query(claim(other)), ["t"])

    def test_expired_simkl_owner_cannot_release_a_new_owner(self):
        first, other = str(uuid.uuid4()), str(uuid.uuid4())
        self.writer.query(f"SELECT public.claim_simkl_write('{self.account}','tt0000001','{first}')")
        self.control.query(f"UPDATE public.simkl_title_writes SET locked_until=clock_timestamp()-interval '1 second' WHERE account_id='{self.account}'")
        self.assertEqual(self.settings.query(f"SELECT public.claim_simkl_write('{self.account}','tt0000001','{other}')"), ["t"])
        self.writer.query(f"SELECT public.release_simkl_write('{self.account}','tt0000001','{first}')")
        self.assertEqual(self.control.query(f"SELECT lease_token FROM public.simkl_title_writes WHERE account_id='{self.account}'"), [other])


if __name__ == "__main__":
    unittest.main()
