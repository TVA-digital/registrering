-- Backup-påmelding av bøssebærere – databaseskjema for Supabase (Postgres)
--
-- Kjør hele fila i Supabase: SQL Editor → New query → lim inn → Run.
-- Fila kan kjøres flere ganger uten å ødelegge data.
--
-- Sikkerhet: Row Level Security er slått på uten policyer, og rettighetene er fjernet fra
-- rollene anon og authenticated. Bare serveren (Vercel-funksjonene med service role-nøkkelen)
-- kan lese og skrive. Nettleseren snakker aldri direkte med databasen.

create table if not exists public.registreringer (
  id         uuid primary key default gen_random_uuid(),
  opprettet  timestamptz not null default now(),
  fornavn    text not null check (char_length(fornavn) between 1 and 60),
  etternavn  text not null check (char_length(etternavn) between 1 and 60),
  epost      text not null unique check (epost = lower(epost) and char_length(epost) <= 254),
  telefon    text not null check (char_length(telefon) <= 20),
  fodselsar  integer not null check (fodselsar between 1900 and 2100),
  sted_id    text not null check (char_length(sted_id) <= 64),
  samtykke   boolean not null default true
);
create index if not exists registreringer_sted_idx on public.registreringer (sted_id);

-- Teller forsøk per (hashet) IP for enkel rate limiting
create table if not exists public.forsok (
  nokkel text not null,
  tid    timestamptz not null default now()
);
create index if not exists forsok_idx on public.forsok (nokkel, tid);

alter table public.registreringer enable row level security;
alter table public.forsok enable row level security;
revoke all on public.registreringer, public.forsok from public, anon, authenticated;

-- Registrerer én påmelding atomisk: unik e-post og kapasitet per oppmøtested.
-- p_maks = null betyr ubegrenset. Kaster EPOST_BRUKT eller STED_FULLT.
create or replace function public.registrer_pamelding(
  p_fornavn text, p_etternavn text, p_epost text, p_telefon text,
  p_fodselsar integer, p_sted_id text, p_maks integer
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_opprettet timestamptz;
  v_antall integer;
begin
  -- Serialiserer påmeldinger til samme sted, så kapasiteten ikke kan overskrides
  perform pg_advisory_xact_lock(hashtext('sted:' || p_sted_id));

  if exists (select 1 from registreringer where epost = p_epost) then
    raise exception 'EPOST_BRUKT' using errcode = 'P0001';
  end if;

  if p_maks is not null then
    select count(*) into v_antall from registreringer where sted_id = p_sted_id;
    if v_antall >= p_maks then
      raise exception 'STED_FULLT' using errcode = 'P0001';
    end if;
  end if;

  begin
    insert into registreringer (fornavn, etternavn, epost, telefon, fodselsar, sted_id)
    values (p_fornavn, p_etternavn, p_epost, p_telefon, p_fodselsar, p_sted_id)
    returning id, opprettet into v_id, v_opprettet;
  exception when unique_violation then
    -- Samme e-post sendt inn samtidig til to forskjellige steder
    raise exception 'EPOST_BRUKT' using errcode = 'P0001';
  end;

  return json_build_object('id', v_id, 'opprettet', v_opprettet);
end;
$$;

-- Antall påmeldte per oppmøtested
create or replace function public.antall_per_sted()
returns table (sted_id text, antall bigint)
language sql
stable
security definer
set search_path = public
as $$
  select r.sted_id, count(*) from registreringer r group by r.sted_id;
$$;

-- Rate limiting: returnerer true hvis forsøket er innenfor grensen (og registrerer det)
create or replace function public.begrens(p_nokkel text, p_maks integer, p_vindu_sek integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_antall integer;
begin
  perform pg_advisory_xact_lock(hashtext('forsok:' || p_nokkel));
  -- Rydder gamle rader av og til, så tabellen holder seg liten
  if random() < 0.05 then
    delete from forsok where tid < now() - interval '1 hour';
  end if;
  select count(*) into v_antall from forsok
   where nokkel = p_nokkel and tid > now() - make_interval(secs => p_vindu_sek);
  if v_antall >= p_maks then
    return false;
  end if;
  insert into forsok (nokkel) values (p_nokkel);
  return true;
end;
$$;

revoke execute on function public.registrer_pamelding(text, text, text, text, integer, text, integer) from public, anon, authenticated;
revoke execute on function public.antall_per_sted() from public, anon, authenticated;
revoke execute on function public.begrens(text, integer, integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, delete on public.registreringer, public.forsok to service_role;
    grant execute on function public.registrer_pamelding(text, text, text, text, integer, text, integer) to service_role;
    grant execute on function public.antall_per_sted() to service_role;
    grant execute on function public.begrens(text, integer, integer) to service_role;
  end if;
end;
$$;
