'use strict';

const crypto = require('node:crypto');
const { EpostBruktFeil, StedFulltFeil } = require('../feil');

/**
 * Firestore-lagring for Google Cloud (Cloud Run). Skalerer horisontalt:
 * unik e-post og kapasitet håndheves i én transaksjon.
 *
 *   registreringer/{uuid}     selve påmeldingen
 *   epostindeks/{sha256}      sikrer at hver e-post kun brukes én gang
 *   tellere/{stedId}          { antall } per oppmøtested
 */
class FirestoreStorage {
  constructor({ prosjekt, database, prefiks = '' } = {}) {
    this.opts = { projectId: prosjekt || undefined, databaseId: database || undefined };
    this.prefiks = prefiks;
  }

  async init() {
    let Firestore;
    try {
      ({ Firestore } = require('@google-cloud/firestore'));
    } catch {
      throw new Error('Pakken @google-cloud/firestore er ikke installert. Kjør "npm install".');
    }
    this.db = new Firestore({ ...this.opts, ignoreUndefinedProperties: true });
    this.reg = this.db.collection(`${this.prefiks}registreringer`);
    this.epost = this.db.collection(`${this.prefiks}epostindeks`);
    this.tellere = this.db.collection(`${this.prefiks}tellere`);
    await this.sjekk();
  }

  async opprett(reg, { maksBackup = null, fulltTekst } = {}) {
    const id = crypto.randomUUID();
    const opprettet = new Date().toISOString();
    const epostRef = this.epost.doc(crypto.createHash('sha256').update(reg.epost).digest('hex'));
    const tellerRef = this.tellere.doc(reg.stedId);
    const regRef = this.reg.doc(id);

    await this.db.runTransaction(async (tx) => {
      const [epostDoc, tellerDoc] = await tx.getAll(epostRef, tellerRef);
      if (epostDoc.exists) throw new EpostBruktFeil();
      const antall = tellerDoc.exists ? Number(tellerDoc.get('antall')) || 0 : 0;
      if (maksBackup !== null && antall >= maksBackup) throw new StedFulltFeil(fulltTekst);

      tx.create(regRef, { ...reg, samtykke: true, opprettet });
      tx.create(epostRef, { registreringId: id, opprettet });
      tx.set(tellerRef, { antall: antall + 1, oppdatert: opprettet });
    });
    return { id, opprettet };
  }

  async antallPerSted() {
    const snap = await this.tellere.get();
    const m = new Map();
    snap.forEach((d) => m.set(d.id, Number(d.get('antall')) || 0));
    return m;
  }

  async alle() {
    const snap = await this.reg.orderBy('opprettet').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async sjekk() {
    await this.tellere.limit(1).get();
  }

  async lukk() {
    await this.db?.terminate();
  }
}

module.exports = { FirestoreStorage };
