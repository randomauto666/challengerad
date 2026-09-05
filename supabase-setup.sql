-- =====================================================================
-- RAD DER CHALLENGES — Supabase-Setup
-- Einmal komplett in den SQL-Editor deines Supabase-Projekts einfügen
-- und ausführen (Dashboard -> SQL Editor -> New query -> Run).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) PROFILE: ein Datensatz pro eingeloggtem Discord-User
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  discord_name text not null,
  discord_avatar text,
  is_admin boolean not null default false,
  group_id uuid,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) GROUPS: "fusionierte" User teilen sich eine group_id
-- ---------------------------------------------------------------------
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_group_fk foreign key (group_id) references public.groups (id) on delete set null;

-- ---------------------------------------------------------------------
-- 3) CUSTOM_ENTRIES: eigene Items/Blöcke/Mobs der User
-- ---------------------------------------------------------------------
create table if not exists public.custom_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('item', 'block', 'mob')),
  name text not null,
  short_name text,
  image_path text,
  world text not null default '',
  is_global boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3b) ANNOUNCEMENTS: Ankündigungen, die der Admin auf der Seite anzeigen kann
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  active boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4) Automatisch ein Profil anlegen, sobald sich jemand per Discord anmeldet
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, discord_name, discord_avatar)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'user_name', 'Unbekannt'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set discord_name = excluded.discord_name,
        discord_avatar = excluded.discord_avatar;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------
-- 5) Hilfsfunktion is_admin() — verhindert rekursive RLS-Policies
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- 6) Row Level Security aktivieren
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.custom_entries enable row level security;
alter table public.announcements enable row level security;

-- profiles: jeder sieht sein eigenes Profil, Admins sehen alle (fürs Adminpanel)
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- profiles: normale User dürfen NICHTS direkt ändern (group_id/is_admin nur über Admin-Funktionen unten)
-- -> bewusst KEINE update/insert/delete-Policy für normale User.

-- groups: keine direkten Policies nötig, Zugriff nur über die Admin-Funktionen (security definer)

-- custom_entries: eigene Einträge ODER Einträge von Leuten in derselben Gruppe
-- ODER als "global" markierte Admin-Einträge (für ALLE sichtbar) ODER Admin (sieht eh alles)
drop policy if exists "custom_entries_select" on public.custom_entries;
create policy "custom_entries_select" on public.custom_entries
  for select using (
    user_id = auth.uid()
    or is_global = true
    or public.is_admin()
    or exists (
      select 1
      from public.profiles me
      join public.profiles owner on owner.group_id = me.group_id
      where me.id = auth.uid()
        and owner.id = custom_entries.user_id
        and me.group_id is not null
    )
  );

-- Normale User dürfen NIE is_global=true setzen, nur Admins (globale Einträge für alle)
drop policy if exists "custom_entries_insert" on public.custom_entries;
create policy "custom_entries_insert" on public.custom_entries
  for insert with check (
    user_id = auth.uid()
    and (is_global = false or public.is_admin())
  );

drop policy if exists "custom_entries_update" on public.custom_entries;
create policy "custom_entries_update" on public.custom_entries
  for update using (user_id = auth.uid() or public.is_admin());

drop policy if exists "custom_entries_delete" on public.custom_entries;
create policy "custom_entries_delete" on public.custom_entries
  for delete using (user_id = auth.uid() or public.is_admin());

-- announcements: jeder darf aktive Ankündigungen lesen, nur Admin darf schreiben/ändern/löschen
drop policy if exists "announcements_select" on public.announcements;
create policy "announcements_select" on public.announcements
  for select using (active = true or public.is_admin());

drop policy if exists "announcements_insert" on public.announcements;
create policy "announcements_insert" on public.announcements
  for insert with check (public.is_admin());

drop policy if exists "announcements_update" on public.announcements;
create policy "announcements_update" on public.announcements
  for update using (public.is_admin());

drop policy if exists "announcements_delete" on public.announcements;
create policy "announcements_delete" on public.announcements
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------
-- 7) Admin-Funktionen: Fusionieren / Trennen / Admin ernennen
--    (security definer -> laufen mit erhöhten Rechten, prüfen is_admin() selbst)
-- ---------------------------------------------------------------------
create or replace function public.admin_merge_users(target_ids uuid[], new_group_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_group uuid;
  result_group uuid;
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen User fusionieren.';
  end if;

  -- vorhandene Gruppe unter den ausgewählten Usern wiederverwenden, falls schon eine existiert
  select group_id into existing_group
  from public.profiles
  where id = any(target_ids) and group_id is not null
  limit 1;

  if existing_group is not null then
    result_group := existing_group;
    if new_group_name is not null then
      update public.groups set name = new_group_name where id = result_group;
    end if;
  else
    insert into public.groups (name) values (new_group_name)
    returning id into result_group;
  end if;

  update public.profiles set group_id = result_group where id = any(target_ids);

  return result_group;
end;
$$;

create or replace function public.admin_separate_user(target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen User trennen.';
  end if;
  update public.profiles set group_id = null where id = target_id;
end;
$$;

create or replace function public.admin_set_admin(target_id uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Nur Admins dürfen Admin-Rechte vergeben.';
  end if;
  update public.profiles set is_admin = make_admin where id = target_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 8) Dich selbst zum ersten Admin machen
--    WICHTIG: Erst einmal ganz normal per Discord auf deiner Seite einloggen,
--    DANACH diese Zeile ausführen (ersetze DEIN-DISCORD-NAME):
-- ---------------------------------------------------------------------
-- update public.profiles set is_admin = true where discord_name = 'DEIN-DISCORD-NAME';

-- ---------------------------------------------------------------------
-- 9) Storage-Bucket für hochgeladene Bilder (öffentlich lesbar)
--    Falls der Bucket noch nicht existiert, im Dashboard unter
--    Storage -> New bucket -> Name: custom-images -> Public bucket: AN
--    anlegen. Die Policies unten danach hier ausführen:
-- ---------------------------------------------------------------------
drop policy if exists "custom_images_public_read" on storage.objects;
create policy "custom_images_public_read" on storage.objects
  for select using (bucket_id = 'custom-images');

drop policy if exists "custom_images_own_upload" on storage.objects;
create policy "custom_images_own_upload" on storage.objects
  for insert with check (
    bucket_id = 'custom-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "custom_images_own_delete" on storage.objects;
create policy "custom_images_own_delete" on storage.objects
  for delete using (
    bucket_id = 'custom-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Fertig! Als Nächstes: Discord-Provider in Supabase aktivieren (Authentication ->
-- Providers -> Discord) und deine Projekt-URL + anon key in supabase-config.js eintragen.
