'use strict';

const { EpostBruktFeil, StedFulltFeil } = require('../feil');

/**
 * Lagring i Supabase (Postgres). Logikken som må være atomisk – unik e-post og kapasitet per
 * oppmøtested – ligger i databasefunksjonen registrer_pamelding (se supabase/schema.sql).
 *
 * Bruker service role-nøkkelen og skal KUN kjøres på serveren (Vercel-funksjonene).
 */
class SupabaseStorage {
  constructor({ url, nokkel } = {}) {
    this.url = url;
    this.nokkel = nokkel;
    this.db = null;
  }

  async init() {
    if (!this.url || !this.nokkel) {
      throw new Error('SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY må være satt.');
    }
    const { createClient } = require('@supabase/supabase-js');
    this.db = createClient(this.url, this.nokkel, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-application-name': 'pamelding-backup' } },
    });
  }

  static feil(error, kontekst) {
    const err = new Error(`Supabase (${kontekst}): ${error.message || error.code || 'ukjent feil'}`);
    err.cause = error;
    return err;
  }

  async opprett(reg, { maksBackup = null, fulltTekst } = {}) {
    const { data, error } = await this.db.rpc('registrer_pamelding', {
      p_fornavn: reg.fornavn,
      p_etternavn: reg.etternavn,
      p_epost: reg.epost,
      p_telefon: reg.telefon,
      p_fodselsar: reg.fodselsar,
      p_sted_id: reg.stedId,
      p_maks: maksBackup,
    });
    if (error) {
      if (/EPOST_BRUKT/.test(error.message) || error.code === '23505') throw new EpostBruktFeil();
      if (/STED_FULLT/.test(error.message)) throw new StedFulltFeil(fulltTekst);
      throw SupabaseStorage.feil(error, 'registrer_pamelding');
    }
    return { id: data.id, opprettet: data.opprettet };
  }

  async antallPerSted() {
    const { data, error } = await this.db.rpc('antall_per_sted');
    if (error) throw SupabaseStorage.feil(error, 'antall_per_sted');
    const m = new Map();
    for (const r of data || []) m.set(r.sted_id, Number(r.antall));
    return m;
  }

  async alle() {
    // PostgREST gir maks 1000 rader per kall, så vi blar gjennom alt.
    const SIDE = 1000;
    const ut = [];
    for (let fra = 0; ; fra += SIDE) {
      const { data, error } = await this.db
        .from('registreringer')
        .select('id, opprettet, fornavn, etternavn, epost, telefon, fodselsar, sted_id, samtykke')
        .order('opprettet', { ascending: true })
        .order('id', { ascending: true })
        .range(fra, fra + SIDE - 1);
      if (error) throw SupabaseStorage.feil(error, 'registreringer');
      for (const r of data) {
        ut.push({
          id: r.id,
          opprettet: r.opprettet,
          fornavn: r.fornavn,
          etternavn: r.etternavn,
          epost: r.epost,
          telefon: r.telefon,
          fodselsar: Number(r.fodselsar),
          stedId: r.sted_id,
          samtykke: Boolean(r.samtykke),
        });
      }
      if (data.length < SIDE) return ut;
    }
  }

  /** true hvis forsøket er innenfor grensen. Feiler åpent (true) hvis databasen ikke svarer. */
  async begrens(nokkel, maks, vinduSek) {
    const { data, error } = await this.db.rpc('begrens', { p_nokkel: nokkel, p_maks: maks, p_vindu_sek: vinduSek });
    if (error) throw SupabaseStorage.feil(error, 'begrens');
    return data !== false;
  }

  async sjekk() {
    const { error } = await this.db.rpc('antall_per_sted');
    if (error) throw SupabaseStorage.feil(error, 'helsesjekk');
  }

  async lukk() {}
}

module.exports = { SupabaseStorage };
