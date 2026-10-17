'use strict';

/** Felles hjelpere for import fra Aksjonsportalen-eksporter. */

const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('./import-oppmotesteder');

const norm = (s) => String(s ?? '').trim().toLocaleLowerCase('nb');

/** Leser en semikolonseparert eksport til en liste med objekter (kolonnenavn → verdi). */
function lesCsv(fil) {
  const raw = fs.readFileSync(fil, 'utf8').replace(/^﻿/, '');
  const [hode, ...rader] = parseCsv(raw, ';');
  return {
    hode,
    rader: rader
      .filter((r) => r.length === hode.length)
      .map((r) => Object.fromEntries(hode.map((h, i) => [h, r[i]]))),
    avvist: rader.filter((r) => r.length !== hode.length).length,
  };
}

function krevKolonner(hode, kolonner, fil) {
  const mangler = kolonner.filter((k) => !hode.includes(k));
  if (mangler.length) {
    throw new Error(`${path.basename(fil)} mangler kolonnene: ${mangler.join(', ')}. Fant: ${hode.join(', ')}`);
  }
}

/**
 * Slår opp oppmøtested-ID fra fylke + kommune + navn (slik Aksjonsportalen eksporterer det).
 * Ved like navn velges stedet med flest påmeldte i hovedsystemet.
 */
function lagStedsoppslag(steder) {
  const indeks = new Map();
  for (const s of steder) {
    const nokkel = `${norm(s.fylke)}|${norm(s.kommune)}|${norm(s.navn)}`;
    if (!indeks.has(nokkel)) indeks.set(nokkel, []);
    indeks.get(nokkel).push(s);
  }
  const tvetydige = new Set();
  function finn(fylke, kommune, navn) {
    const treff = indeks.get(`${norm(fylke)}|${norm(kommune)}|${norm(navn)}`);
    if (!treff) return null;
    if (treff.length > 1) {
      tvetydige.add(`${treff[0].navn} (${treff[0].kommune})`);
      return [...treff].sort((a, b) => (b.pameldtHovedsystem || 0) - (a.pameldtHovedsystem || 0))[0];
    }
    return treff[0];
  }
  return { finn, tvetydige };
}

function lesSteder() {
  return require('../data/oppmotesteder.json').steder;
}

/** Supabase-klient med service role-nøkkel (kun for --skriv). */
function supabase() {
  const url = process.env.SUPABASE_URL;
  const nokkel = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !nokkel) throw new Error('Sett SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY for å skrive til databasen.');
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, nokkel, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Synkroniserer en tabell: upsert av alle rader, og sletting av rader som ikke lenger finnes i fila.
 */
async function synkroniser(db, tabell, nokkel, rader) {
  const STOR = 500;
  for (let i = 0; i < rader.length; i += STOR) {
    const { error } = await db.from(tabell).upsert(rader.slice(i, i + STOR), { onConflict: nokkel });
    if (error) throw new Error(`Upsert til ${tabell} feilet: ${error.message}`);
  }
  const nye = new Set(rader.map((r) => r[nokkel]));
  const gamle = [];
  for (let fra = 0; ; fra += 1000) {
    const { data, error } = await db.from(tabell).select(nokkel).range(fra, fra + 999);
    if (error) throw new Error(`Lesing av ${tabell} feilet: ${error.message}`);
    gamle.push(...data.map((r) => r[nokkel]));
    if (data.length < 1000) break;
  }
  const slett = gamle.filter((k) => !nye.has(k));
  for (let i = 0; i < slett.length; i += 200) {
    const { error } = await db.from(tabell).delete().in(nokkel, slett.slice(i, i + 200));
    if (error) throw new Error(`Sletting i ${tabell} feilet: ${error.message}`);
  }
  return { skrevet: rader.length, slettet: slett.length };
}

function argument(args, navn) {
  const a = args.find((x) => x.startsWith(`--${navn}=`));
  return a ? a.slice(navn.length + 3) : null;
}

module.exports = { norm, lesCsv, krevKolonner, lagStedsoppslag, lesSteder, supabase, synkroniser, argument };
