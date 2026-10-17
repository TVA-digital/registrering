'use strict';

const { AppError } = require('../feil');

/**
 * Datatilgang for nødmodulen. Alt går via databasefunksjonene i supabase/schema-ansvarlig.sql.
 * `kall(funksjon, args, { form })` utfører funksjonen: Supabase bruker rpc, testene PGlite.
 */
class AnsvarligStorage {
  constructor(kall) {
    this.kall = kall;
  }

  async hentAnsvarlig(epost) {
    const rader = await this.kall('hent_ansvarlig', { p_epost: epost }, { form: 'rader' });
    return rader?.[0] || null;
  }

  async lagKode(epost, kodeHash, gyldigSek) {
    await this.kall('lag_kode', { p_epost: epost, p_kode_hash: kodeHash, p_gyldig_sek: gyldigSek }, { form: 'verdi' });
  }

  async brukKode(epost, kodeHash) {
    return (await this.kall('bruk_kode', { p_epost: epost, p_kode_hash: kodeHash }, { form: 'verdi' })) === true;
  }

  async bossebaerere(stedId) {
    const rader = await this.kall('bossebaerere_for_sted', { p_sted_id: stedId }, { form: 'rader' });
    return (rader || []).map((r) => ({
      personRef: r.person_ref,
      kilde: r.kilde,
      fornavn: r.fornavn,
      etternavn: r.etternavn,
      telefon: r.telefon,
      epost: r.epost,
      utTid: r.ut_tid ? new Date(r.ut_tid).toISOString() : null,
      innTid: r.inn_tid ? new Date(r.inn_tid).toISOString() : null,
    }));
  }

  async settStatus(personRef, stedId, handling, av) {
    try {
      const svar = await this.kall('sett_status',
        { p_person_ref: personRef, p_sted_id: stedId, p_handling: handling, p_av: av }, { form: 'verdi' });
      return {
        personRef: svar.personRef,
        utTid: svar.utTid ? new Date(svar.utTid).toISOString() : null,
        innTid: svar.innTid ? new Date(svar.innTid).toISOString() : null,
      };
    } catch (err) {
      if (/UKJENT_PERSON/.test(err.message)) {
        throw new AppError('Fant ikke bøssebæreren på dette oppmøtestedet. Oppdater lista og prøv igjen.', { status: 404, kode: 'ukjent_person' });
      }
      if (/UGYLDIG_HANDLING/.test(err.message)) throw new AppError('Ugyldig handling.', { status: 400, kode: 'ugyldig' });
      throw err;
    }
  }

  async begrens(nokkel, maks, vinduSek) {
    return (await this.kall('begrens', { p_nokkel: nokkel, p_maks: maks, p_vindu_sek: vinduSek }, { form: 'verdi' })) !== false;
  }
}

/** Utfører for Supabase-klienten (service role). */
function supabaseKall(db) {
  return async (funksjon, args) => {
    const { data, error } = await db.rpc(funksjon, args);
    if (error) {
      const err = new Error(`Supabase (${funksjon}): ${error.message || error.code}`);
      err.cause = error;
      throw err;
    }
    return data;
  };
}

module.exports = { AnsvarligStorage, supabaseKall };
