-- QARAR cleanup, 4 Oct 2026
-- 1. Saves a private backup of everything it touches (schema "backup", not reachable from the app).
-- 2. Moves the candidates added in the last 10 days into the new "Ui designer" job.
-- 3. Deletes every other job and the older candidates.
-- Runs as one block: if anything fails, nothing changes.

begin;

create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;
create table backup.jobs_20261004 as select * from public.jobs;
create table backup.candidates_20261004 as select * from public.candidates;
create table backup.notes_20261004 as select * from public.notes;
create table backup.offers_20261004 as select * from public.offers;
create table backup.hires_20261004 as select * from public.hires;
create table backup.batches_20261004 as select * from public.batches;
create table backup.job_messages_20261004 as select * from public.job_messages;
create table backup.screenings_20261004 as select * from public.screenings;

do $$
declare keep uuid := '7917f53c-bceb-4f03-b83b-8313e72e6938';  -- "Ui designer", created 3 Oct
begin
  if not exists (select 1 from public.jobs where id = keep) then
    raise exception 'The new job is missing, nothing was changed';
  end if;
  update public.candidates set job_id = keep where created_at > now() - interval '10 days';
  delete from public.candidates where created_at <= now() - interval '10 days';
  delete from public.jobs where id <> keep;
end $$;

commit;

-- Check: should show 1 job and 3 candidates
select (select count(*) from public.jobs) as jobs, (select count(*) from public.candidates) as candidates;
