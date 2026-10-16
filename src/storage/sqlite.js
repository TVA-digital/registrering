'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { EpostBruktFeil, StedFulltFeil } = require('../feil');

/**
 * SQLite-lagring. Egnet for kjøring på én server/VM med persistent disk,
 * og for lokal utvikling. IKKE bruk på Cloud Run uten volum – disken der er flyktig.
 */
class SqliteStorage {
  constructor({ fil }) {
    this.fil = fil;
    this.db = null;
  }

  async init() {
    if (this.fil !== ':memory:') fs.mkdirSync(path.dirname(this.fil), { recursive: true });
    this.db = new DatabaseSync(this.fil);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS registreringer (
        id          TEXT PRIMARY KEY,
        opprettet   TEXT NOT NULL,
        fornavn     TEXT NOT NULL,
        etternavn   TEXT NOT NULL,
        epost       TEXT NOT NULL UNIQUE,
        telefon     TEXT NOT NULL,
        fodselsar   INTEGER NOT NULL,
        sted_id     TEXT NOT NULL,
        samtykke    INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_reg_sted ON registreringer(sted_id);
      CREATE TABLE IF NOT EXISTS forsok (nokkel TEXT NOT NULL, tid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_forsok ON forsok(nokkel, tid);
    `);
    this.stmt = {
      tell: this.db.prepare('SELECT COUNT(*) AS n FROM registreringer WHERE sted_id = ?'),
      finnEpost: this.db.prepare('SELECT 1 FROM registreringer WHERE epost = ?'),
      sett: this.db.prepare(`INSERT INTO registreringer
        (id, opprettet, fornavn, etternavn, epost, telefon, fodselsar, sted_id, samtykke)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      perSted: this.db.prepare('SELECT sted_id, COUNT(*) AS n FROM registreringer GROUP BY sted_id'),
      alle: this.db.prepare('SELECT * FROM registreringer ORDER BY opprettet'),
      ryddForsok: this.db.prepare('DELETE FROM forsok WHERE tid < ?'),
      tellForsok: this.db.prepare('SELECT COUNT(*) AS n FROM forsok WHERE nokkel = ? AND tid > ?'),
      settForsok: this.db.prepare('INSERT INTO forsok (nokkel, tid) VALUES (?, ?)'),
    };
  }

  /**
   * @param reg      validert påmelding
   * @param maksBackup  maks antall påmeldinger backupen kan ta for stedet (null = ubegrenset)
   * @param fulltTekst  tekst som vises hvis stedet er fullt
   */
  async opprett(reg, { maksBackup = null, fulltTekst } = {}) {
    const id = crypto.randomUUID();
    const opprettet = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.stmt.finnEpost.get(reg.epost)) throw new EpostBruktFeil();
      if (maksBackup !== null && this.stmt.tell.get(reg.stedId).n >= maksBackup) {
        throw new StedFulltFeil(fulltTekst);
      }
      this.stmt.sett.run(id, opprettet, reg.fornavn, reg.etternavn, reg.epost, reg.telefon, reg.fodselsar, reg.stedId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) throw new EpostBruktFeil();
      throw err;
    }
    return { id, opprettet };
  }

  async antallPerSted() {
    const m = new Map();
    for (const r of this.stmt.perSted.all()) m.set(r.sted_id, Number(r.n));
    return m;
  }

  async alle() {
    return this.stmt.alle.all().map((r) => ({
      id: r.id,
      opprettet: r.opprettet,
      fornavn: r.fornavn,
      etternavn: r.etternavn,
      epost: r.epost,
      telefon: r.telefon,
      fodselsar: Number(r.fodselsar),
      stedId: r.sted_id,
      samtykke: Boolean(r.samtykke),
    }));
  }

  async begrens(nokkel, maks, vinduSek) {
    const na = Date.now();
    this.stmt.ryddForsok.run(na - 3_600_000);
    if (this.stmt.tellForsok.get(nokkel, na - vinduSek * 1000).n >= maks) return false;
    this.stmt.settForsok.run(nokkel, na);
    return true;
  }

  async sjekk() {
    this.db.prepare('SELECT 1').get();
  }

  async lukk() {
    this.db?.close();
    this.db = null;
  }
}

module.exports = { SqliteStorage };
