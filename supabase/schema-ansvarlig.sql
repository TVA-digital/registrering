-- Nødmodul for ansvarlige: innlogging med engangskode og inn-/utsjekk av bøssebærere.
--
-- Kjøres i Supabase (SQL Editor) ETTER supabase/schema.sql. Kan kjøres flere ganger.
-- Samme sikkerhetsmodell: RLS på, ingen rettigheter for anon/authenticated, kun service_role.

-- Hvem som kan logge inn, og hva de har tilgang til.
-- tilganger: 'sted:<oppmøtested-id>', 'kommune:<kommune>' eller 'kommune:<fylke>/<kommune>', 'fylke:<fylke>', 'nasjonal'
create table if not exists public.ansvarlige (
  epost      text primary key check (epost = lower(epost)),
  navn       text not null default '',
  tilganger  text[] not null default '{}',
  oppdatert  timestamptz not null default now()
);

-- Påmeldte bøssebærere importert fra Aksjonsportalen
create table if not exists public.bossebaerere_import (
  ekstern_id  text primary key,
  fornavn     text not null default '',
  etternavn   text not null default '',
  epost       text not null default '',
  telefon     text not null default '',
  sted_id     text not null,
  importert   timestamptz not null default now()
);
create index if not exists bossebaerere_import_sted_idx on public.bossebaerere_import (sted_id);

-- Status på aksjonsdagen. person_ref = 'ap:<ekstern_id>' (Aksjonsportalen) eller 'bk:<uuid>' (backup-påmelding)
create table if not exists public.oppmote_status (
  person_ref  text primary key,
  sted_id     text not null,
  ut_tid      timestamptz,
  ut_av       text,
  inn_tid     timestamptz,
  inn_av      text
);

-- Logg over alt som gjøres i modulen
create table if not exists public.hendelser (
  id          bigint generated always as identity primary key,
  tid         timestamptz not null default now(),
  epost       text not null,
  handling    text not null,
  person_ref  text,
  sted_id     text
);

create table if not exists public.engangskoder (
  id         bigint generated always as identity primary key,
  epost      text not null,
  kode_hash  text not null,
  utloper    timestamptz not null,
  forsok     integer not null default 0,
  brukt      boolean not null default false,
  opprettet  timestamptz not null default now()
);
create index if not exists engangskoder_epost_idx on public.engangskoder (epost, opprettet desc);

alter table public.ansvarlige enable row level security;
alter table public.bossebaerere_import enable row level security;
alter table public.oppmote_status enable row level security;
alter table public.hendelser enable row level security;
alter table public.engangskoder enable row level security;
revoke all on public.ansvarlige, public.bossebaerere_import, public.oppmote_status, public.hendelser, public.engangskoder
  from public, anon, authenticated;

-- ---------- Innlogging ----------

create or replace function public.hent_ansvarlig(p_epost text)
returns table (epost text, navn text, tilganger text[])
language sql stable security definer set search_path = public
as $$
  select a.epost, a.navn, a.tilganger from ansvarlige a where a.epost = lower(p_epost);
$$;

-- Lager en ny kode og ugyldiggjør tidligere ubrukte koder for samme e-post
create or replace function public.lag_kode(p_epost text, p_kode_hash text, p_gyldig_sek integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update engangskoder set brukt = true where epost = lower(p_epost) and not brukt;
  insert into engangskoder (epost, kode_hash, utloper)
  values (lower(p_epost), p_kode_hash, now() + make_interval(secs => p_gyldig_sek));
  delete from engangskoder where opprettet < now() - interval '1 day';
end;
$$;

-- true hvis koden stemmer. Maks 5 forsøk per kode; koden kan bare brukes én gang.
create or replace function public.bruk_kode(p_epost text, p_kode_hash text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v engangskoder%rowtype;
begin
  select * into v from engangskoder
   where epost = lower(p_epost) and not brukt and utloper > now()
   order by opprettet desc limit 1
   for update;
  if not found or v.forsok >= 5 then
    return false;
  end if;
  if v.kode_hash = p_kode_hash then
    update engangskoder set brukt = true where id = v.id;
    insert into hendelser (epost, handling) values (lower(p_epost), 'logget inn');
    return true;
  end if;
  update engangskoder set forsok = forsok + 1 where id = v.id;
  return false;
end;
$$;

-- ---------- Bøssebærere og status ----------

create or replace function public.bossebaerere_for_sted(p_sted_id text)
returns table (person_ref text, kilde text, fornavn text, etternavn text, telefon text, epost text,
               ut_tid timestamptz, inn_tid timestamptz)
language sql stable security definer set search_path = public
as $$
  with personer as (
    select 'ap:' || b.ekstern_id as person_ref, 'Aksjonsportalen'::text as kilde,
           b.fornavn, b.etternavn, b.telefon, b.epost
      from bossebaerere_import b where b.sted_id = p_sted_id
    union all
    select 'bk:' || r.id::text, 'Backup', r.fornavn, r.etternavn, r.telefon, r.epost
      from registreringer r where r.sted_id = p_sted_id
  )
  select p.person_ref, p.kilde, p.fornavn, p.etternavn, p.telefon, p.epost, s.ut_tid, s.inn_tid
    from personer p left join oppmote_status s on s.person_ref = p.person_ref
   order by lower(p.fornavn), lower(p.etternavn);
$$;

-- handling: 'ut' (henter bøsse), 'inn' (leverer bøsse), 'angre' (tilbake ett steg)
create or replace function public.sett_status(p_person_ref text, p_sted_id text, p_handling text, p_av text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_finnes boolean;
  v oppmote_status%rowtype;
begin
  if p_handling not in ('ut', 'inn', 'angre') then
    raise exception 'UGYLDIG_HANDLING' using errcode = 'P0001';
  end if;

  if p_person_ref like 'ap:%' then
    select exists (select 1 from bossebaerere_import
                    where ekstern_id = substr(p_person_ref, 4) and sted_id = p_sted_id) into v_finnes;
  elsif p_person_ref ~ '^bk:[0-9a-f-]{36}$' then
    select exists (select 1 from registreringer
                    where id = substr(p_person_ref, 4)::uuid and sted_id = p_sted_id) into v_finnes;
  else
    v_finnes := false;
  end if;
  if not v_finnes then
    raise exception 'UKJENT_PERSON' using errcode = 'P0001';
  end if;

  insert into oppmote_status (person_ref, sted_id) values (p_person_ref, p_sted_id)
  on conflict (person_ref) do nothing;
  select * into v from oppmote_status where person_ref = p_person_ref for update;

  if p_handling = 'ut' then
    update oppmote_status set sted_id = p_sted_id, ut_tid = now(), ut_av = p_av, inn_tid = null, inn_av = null
     where person_ref = p_person_ref;
  elsif p_handling = 'inn' then
    update oppmote_status set sted_id = p_sted_id, ut_tid = coalesce(ut_tid, now()), ut_av = coalesce(ut_av, p_av),
           inn_tid = now(), inn_av = p_av
     where person_ref = p_person_ref;
  elsif v.inn_tid is not null then
    update oppmote_status set inn_tid = null, inn_av = null where person_ref = p_person_ref;
  else
    update oppmote_status set ut_tid = null, ut_av = null where person_ref = p_person_ref;
  end if;

  insert into hendelser (epost, handling, person_ref, sted_id) values (p_av, p_handling, p_person_ref, p_sted_id);

  select * into v from oppmote_status where person_ref = p_person_ref;
  return json_build_object('personRef', v.person_ref, 'utTid', v.ut_tid, 'innTid', v.inn_tid);
end;
$$;

revoke execute on function public.hent_ansvarlig(text) from public, anon, authenticated;
revoke execute on function public.lag_kode(text, text, integer) from public, anon, authenticated;
revoke execute on function public.bruk_kode(text, text) from public, anon, authenticated;
revoke execute on function public.bossebaerere_for_sted(text) from public, anon, authenticated;
revoke execute on function public.sett_status(text, text, text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete
      on public.ansvarlige, public.bossebaerere_import, public.oppmote_status, public.hendelser, public.engangskoder
      to service_role;
    grant execute on function public.hent_ansvarlig(text) to service_role;
    grant execute on function public.lag_kode(text, text, integer) to service_role;
    grant execute on function public.bruk_kode(text, text) to service_role;
    grant execute on function public.bossebaerere_for_sted(text) to service_role;
    grant execute on function public.sett_status(text, text, text, text) to service_role;
  end if;
end;
$$;
