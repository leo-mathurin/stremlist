-- letterboxd_take was kept for backend instances that still called it during
-- a deploy. No deployed backend calls it: letterboxd_take_turn replaced it
-- before the Letterboxd gate reached production.
DROP FUNCTION public.letterboxd_take(double precision, integer, boolean, text);
