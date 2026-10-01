-- OwnTracker: run this file once in your project's SQL Editor.
-- Safe to run again. It does not delete existing tables or user data.
-- Only authenticated users can call the API. All reads/writes are scoped to auth.uid().
begin;

create table if not exists public.owntracker_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  description text not null default '' check (length(description) <= 4000),
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  active_from date not null,
  archived_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (id, user_id),
  check (archived_on is null or archived_on >= active_from)
);
create table if not exists public.owntracker_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  change_id bigint not null,
  date date not null,
  status text not null check (status in ('done', 'missed', 'other')),
  explanation text not null default '' check (length(explanation) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  foreign key (change_id, user_id) references public.owntracker_changes(id, user_id),
  unique (change_id, date)
);
create index if not exists owntracker_changes_owner on public.owntracker_changes(user_id, created_at);
create index if not exists owntracker_entries_owner on public.owntracker_entries(user_id, date);

alter table public.owntracker_changes enable row level security;
alter table public.owntracker_entries enable row level security;
drop policy if exists owntracker_read_changes on public.owntracker_changes;
create policy owntracker_read_changes on public.owntracker_changes for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists owntracker_read_entries on public.owntracker_entries;
create policy owntracker_read_entries on public.owntracker_entries for select to authenticated using ((select auth.uid()) = user_id);

-- Direct mutation is intentionally unavailable. The RPC enforces versions, dates and archiving.
revoke all on public.owntracker_changes, public.owntracker_entries from anon, authenticated;
grant select on public.owntracker_changes, public.owntracker_entries to authenticated;
revoke all on sequence public.owntracker_changes_id_seq, public.owntracker_entries_id_seq from anon, authenticated;

create or replace function public.owntracker_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  current_day date := (statement_timestamp() at time zone 'Asia/Jerusalem')::date;
  change_row public.owntracker_changes%rowtype;
  entry_row public.owntracker_entries%rowtype;
  requested_date date;
  requested_id bigint;
  input_title text;
  input_description text;
  input_frequency text;
  input_explanation text;
  input_status text;
begin
  if owner_id is null then
    return jsonb_build_object('status', 401, 'error', 'יש להתחבר כדי להשתמש באפליקציה.');
  end if;
  if action = 'state' then
    return jsonb_build_object(
      'today', current_day,
      'timezone', 'Asia/Jerusalem',
      'changes', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at, c.id) from public.owntracker_changes c where c.user_id = owner_id), '[]'::jsonb),
      'entries', coalesce((select jsonb_agg(to_jsonb(e) order by e.date, e.change_id) from public.owntracker_entries e where e.user_id = owner_id), '[]'::jsonb)
    );
  end if;
  if action not in ('create_change', 'update_change', 'archive_change', 'create_entry', 'update_entry') then
    return jsonb_build_object('status', 400, 'error', 'פעולה לא מוכרת.');
  end if;
  if action in ('create_change', 'update_change') then
    input_title := btrim(payload->>'title');
    input_description := btrim(coalesce(payload->>'description', ''));
    input_frequency := payload->>'frequency';
    if input_title is null or length(input_title) not between 1 and 120 or length(input_description) > 4000
      or input_frequency is null or input_frequency not in ('daily','weekly','monthly') then
      return jsonb_build_object('status', 400, 'error', 'יש להזין כותרת עד 120 תווים, תיאור עד 4000 תווים ותדירות תקינה.');
    end if;
  end if;
  if action = 'create_change' then
    insert into public.owntracker_changes (user_id, title, description, frequency, active_from)
      values (owner_id, input_title, input_description, input_frequency, current_day)
      returning * into change_row;
    return to_jsonb(change_row);
  end if;

  requested_id := (payload->>'id')::bigint;
  -- Locking the parent serializes entry creation and archive on both devices.
  select * into change_row from public.owntracker_changes c
    where c.id = requested_id and c.user_id = owner_id for update;
  if not found then return jsonb_build_object('status', 404, 'error', 'השינוי לא נמצא.'); end if;
  if action in ('update_change', 'archive_change') then
    if change_row.version is distinct from (payload->>'version')::integer then
      return jsonb_build_object('status', 409, 'error', 'השינוי עודכן במכשיר אחר. יש לפתוח אותו מחדש לפני שמירה.');
    end if;
    if change_row.archived_on is not null then
      return jsonb_build_object('status', 400, 'error', 'השינוי כבר נמחק. ההיסטוריה שלו נשמרת.');
    end if;
    if action = 'archive_change' then
      update public.owntracker_changes set archived_on = current_day, updated_at = now(), version = version + 1
        where id = requested_id and user_id = owner_id returning * into change_row;
    else
      update public.owntracker_changes set title = input_title, description = input_description,
        frequency = input_frequency, updated_at = now(), version = version + 1
        where id = requested_id and user_id = owner_id returning * into change_row;
    end if;
    return to_jsonb(change_row);
  end if;

  if coalesce(payload->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('status', 400, 'error', 'יש לבחור תאריך תקין.');
  end if;
  requested_date := (payload->>'date')::date;
  input_status := payload->>'status';
  input_explanation := btrim(coalesce(payload->>'explanation', ''));
  if requested_date < date '1900-01-01' or requested_date > current_day then
    return jsonb_build_object('status', 400, 'error', 'אפשר לדווח עד לתאריך היום, ללא תאריכים עתידיים.');
  end if;
  if change_row.archived_on is not null and requested_date > change_row.archived_on then
    return jsonb_build_object('status', 400, 'error', 'התאריך מאוחר ממועד מחיקת השינוי.');
  end if;
  if input_status is null or input_status not in ('done','missed','other') or length(input_explanation) > 8000 then
    return jsonb_build_object('status', 400, 'error', 'יש לבחור מצב דיווח תקין והסבר עד 8000 תווים.');
  end if;
  select * into entry_row from public.owntracker_entries e
    where e.change_id = requested_id and e.date = requested_date and e.user_id = owner_id;
  if action = 'create_entry' and found then
    return jsonb_build_object('status', 409, 'error', 'כבר קיים דיווח לתאריך הזה. אפשר לעבור לעריכתו.', 'entry', to_jsonb(entry_row));
  end if;
  if action = 'update_entry' then
    if entry_row.id is null then return jsonb_build_object('status', 404, 'error', 'הדיווח לא נמצא.'); end if;
    if entry_row.version is distinct from (payload->>'version')::integer then
      return jsonb_build_object('status', 409, 'error', 'הדיווח עודכן במכשיר אחר. יש לטעון את הגרסה העדכנית.', 'entry', to_jsonb(entry_row));
    end if;
    update public.owntracker_entries set status = input_status, explanation = input_explanation,
      updated_at = now(), version = version + 1 where id = entry_row.id and user_id = owner_id returning * into entry_row;
  else
    insert into public.owntracker_entries (user_id, change_id, date, status, explanation)
      values (owner_id, requested_id, requested_date, input_status, input_explanation) returning * into entry_row;
  end if;
  if requested_date < change_row.active_from then
    update public.owntracker_changes set active_from = requested_date where id = requested_id and user_id = owner_id;
  end if;
  return to_jsonb(entry_row);
exception
  when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or check_violation then
    return jsonb_build_object('status', 400, 'error', 'חלק מהפרטים אינם תקינים. בדקו את התאריך והשדות ונסו שוב.');
end;
$$;

revoke all on function public.owntracker_api(text, jsonb) from public, anon, authenticated;
grant execute on function public.owntracker_api(text, jsonb) to authenticated;
commit;
