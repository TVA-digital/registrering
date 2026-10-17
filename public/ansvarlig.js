(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VISNINGER = ['epost', 'kode', 'steder', 'liste'];
  const OPPDATER_MS = 20_000;
  const MAKS_STEDER = 100;
  const collator = new Intl.Collator('nb');

  const state = {
    epost: '',
    meg: null,
    sted: null,
    personer: [],
    filter: 'alle',
    timer: null,
  };

  // ---------- Hjelpere ----------

  function lesLagret(k) {
    try { return localStorage.getItem(k) || ''; } catch { return ''; }
  }
  function lagre(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* privat modus */ }
  }

  function vis(navn) {
    $('laster').hidden = true;
    for (const v of VISNINGER) $(`vis-${v}`).hidden = v !== navn;
    $('bruker').hidden = !state.meg;
    if (navn !== 'liste') stoppOppdatering();
  }

  function feil(melding) {
    $('feil').textContent = melding || '';
    $('feil').hidden = !melding;
    if (melding) $('feil').focus();
  }

  class IkkeInnlogget extends Error {}

  async function api(sti, { metode = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`/api/ansvarlig/${sti}`, {
        method: metode,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Fikk ikke kontakt med serveren. Sjekk nettforbindelsen og prøv igjen.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && sti !== 'logginn') throw new IkkeInnlogget();
    if (!res.ok) throw new Error(data.feil || `Noe gikk galt (HTTP ${res.status}).`);
    return data;
  }

  function haandter(err) {
    if (err instanceof IkkeInnlogget) {
      state.meg = null;
      vis('epost');
      feil('Du er logget ut. Logg inn på nytt.');
      return;
    }
    console.error(err);
    feil(err.message);
  }

  // Valgt oppmøtested huskes per bruker, så neste person på samme enhet ikke havner på feil sted.
  const stedNokkel = () => `ansvarligSted:${state.meg?.epost || ''}`;

  const klokke = (iso) => new Date(iso).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });

  function el(tag, attrs = {}, ...barn) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('data-')) e.setAttribute(k, v);
      else e[k] = v;
    }
    for (const b of barn) if (b != null) e.append(b);
    return e;
  }

  // ---------- Innlogging ----------

  async function sendKode(e) {
    e.preventDefault();
    feil('');
    const epost = $('epost').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(epost)) {
      feil('Skriv inn en gyldig e-postadresse.');
      $('epost').focus();
      return;
    }
    const knapp = $('send-kode');
    knapp.disabled = true;
    try {
      const svar = await api('kode', { metode: 'POST', body: { epost } });
      state.epost = epost;
      lagre('ansvarligEpost', epost);
      $('kode-info').textContent = `${svar.melding} Sjekk også søppelpost. Koden sendes til ${epost}.`;
      $('kode').value = '';
      vis('kode');
      $('kode').focus();
    } catch (err) {
      haandter(err);
    } finally {
      knapp.disabled = false;
    }
  }

  async function loggInn(e) {
    e.preventDefault();
    feil('');
    const kode = $('kode').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(kode)) {
      feil('Koden består av 6 siffer.');
      $('kode').focus();
      return;
    }
    const knapp = $('logg-inn');
    knapp.disabled = true;
    try {
      await api('logginn', { metode: 'POST', body: { epost: state.epost, kode } });
      await start();
    } catch (err) {
      haandter(err);
    } finally {
      knapp.disabled = false;
    }
  }

  async function loggUt() {
    try { await api('loggut', { metode: 'POST', body: {} }); } catch { /* logg ut lokalt uansett */ }
    state.meg = null;
    state.sted = null;
    feil('');
    vis('epost');
  }

  // ---------- Oppstart og stedvalg ----------

  async function start() {
    try {
      state.meg = await api('meg');
    } catch (err) {
      if (err instanceof IkkeInnlogget) {
        $('epost').value = lesLagret('ansvarligEpost');
        vis('epost');
        return;
      }
      vis('epost');
      return haandter(err);
    }
    $('bruker-navn').textContent = [state.meg.navn || state.meg.epost, state.meg.rolle].filter(Boolean).join(' · ');
    feil('');

    const steder = state.meg.steder;
    if (!steder.length) {
      vis('steder');
      $('steder-info').textContent = 'Du har ingen oppmøtesteder knyttet til deg. Kontakt fylkesaksjonslederen din.';
      $('sted-sok').hidden = true;
      return;
    }
    const husket = steder.find((s) => s.id === lesLagret(stedNokkel()));
    if (steder.length === 1) return velgSted(steder[0]);
    if (husket) return velgSted(husket);
    visSteder();
  }

  function visSteder() {
    const steder = state.meg.steder;
    $('steder-info').textContent = `Du har tilgang til ${steder.length} oppmøtesteder.`;
    $('sted-sok').hidden = false;
    $('sted-sok').value = '';
    tegnSteder();
    vis('steder');
    $('sted-sok').focus();
  }

  function tegnSteder() {
    const sok = $('sted-sok').value.trim().toLocaleLowerCase('nb');
    const treff = state.meg.steder.filter((s) =>
      !sok || `${s.navn} ${s.kommune} ${s.fylke}`.toLocaleLowerCase('nb').includes(sok));
    $('sted-liste').replaceChildren(...treff.slice(0, MAKS_STEDER).map((s) =>
      el('li', {}, el('button', { type: 'button', 'data-id': s.id },
        el('strong', {}, s.navn),
        el('span', {}, [s.kommune, s.fylke].filter(Boolean).join(', ')),
        el('span', {}, [s.tid, s.adresse].filter(Boolean).join(' · '))))));
    $('sted-flere').hidden = treff.length <= MAKS_STEDER && treff.length > 0;
    $('sted-flere').textContent = treff.length === 0
      ? 'Ingen oppmøtesteder passer søket.'
      : `Viser ${MAKS_STEDER} av ${treff.length}. Søk for å snevre inn.`;
  }

  function velgSted(sted) {
    state.sted = sted;
    state.filter = 'alle';
    state.personer = [];
    lagre(stedNokkel(), sted.id);
    $('sted-navn').textContent = sted.navn;
    $('sted-detaljer').textContent = [[sted.kommune, sted.fylke].filter(Boolean).join(', '), sted.tid, sted.adresse]
      .filter(Boolean).join(' · ');
    $('bytt-sted').hidden = state.meg.steder.length <= 1;
    $('sok').value = '';
    $('liste').replaceChildren();
    $('tom').hidden = true;
    oppdaterTellere();
    vis('liste');
    hentListe();
    startOppdatering();
  }

  // ---------- Bøssebærere ----------

  function statusFor(p) {
    if (p.innTid) return 'levert';
    if (p.utTid) return 'ute';
    return 'ikke';
  }

  async function hentListe({ stille = false } = {}) {
    const sted = state.sted;
    if (!sted) return;
    if (!stille) $('oppdater').disabled = true;
    try {
      const data = await api(`bossebaerere?sted=${encodeURIComponent(sted.id)}`);
      if (state.sted !== sted) return; // byttet sted mens vi ventet
      state.personer = data.bossebaerere;
      $('oppdatert').textContent = `Sist oppdatert kl. ${klokke(data.hentet)}`;
      if (!stille) feil('');
      tegnListe();
    } catch (err) {
      haandter(err);
    } finally {
      $('oppdater').disabled = false;
    }
  }

  function oppdaterTellere() {
    const tell = { alle: state.personer.length, ikke: 0, ute: 0, levert: 0 };
    for (const p of state.personer) tell[statusFor(p)]++;
    for (const k of Object.keys(tell)) $(`t-${k}`).textContent = tell[k];
    for (const b of document.querySelectorAll('.teller')) b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
  }

  function tegnListe() {
    oppdaterTellere();
    const sok = $('sok').value.trim().toLocaleLowerCase('nb');
    const sokTall = sok.replace(/\D/g, '');
    const treff = state.personer
      .filter((p) => state.filter === 'alle' || statusFor(p) === state.filter)
      .filter((p) => !sok ||
        `${p.fornavn} ${p.etternavn}`.toLocaleLowerCase('nb').includes(sok) ||
        (sokTall.length >= 3 && p.telefon.replace(/\D/g, '').includes(sokTall)))
      .sort((a, b) => collator.compare(`${a.fornavn} ${a.etternavn}`, `${b.fornavn} ${b.etternavn}`));

    $('liste').replaceChildren(...treff.map(personRad));
    $('tom').hidden = treff.length > 0;
    $('tom').textContent = state.personer.length === 0
      ? 'Ingen påmeldte bøssebærere på dette stedet.'
      : 'Ingen bøssebærere passer søket eller filteret.';
  }

  function personRad(p) {
    const status = statusFor(p);
    const statusTekst = {
      ikke: 'Ikke møtt',
      ute: `Ute siden ${p.utTid ? klokke(p.utTid) : ''}`,
      levert: `Levert ${p.innTid ? klokke(p.innTid) : ''}`,
    }[status];

    const knapper = [];
    if (status === 'ikke') knapper.push(knapp('Sjekk ut – henter bøsse', 'ut', 'knapp knapp--ut'));
    if (status === 'ute') knapper.push(knapp('Sjekk inn – levert bøsse', 'inn', 'knapp knapp--inn'));
    if (status !== 'ikke') knapper.push(knapp('Angre', 'angre', 'knapp knapp--sekundar knapp--liten'));

    const info = [];
    if (p.telefon) info.push(el('a', { href: `tel:${p.telefon.replace(/[^\d+]/g, '')}` }, p.telefon));
    if (p.kilde === 'Backup') info.push(el('span', { class: 'merke' }, 'Meldt på i backup'));

    return el('li', { class: `person person--${status}`, 'data-ref': p.personRef },
      el('div', {}, el('div', { class: 'person__navn' }, `${p.fornavn} ${p.etternavn}`.trim() || '(uten navn)'),
        el('div', { class: 'person__info' }, ...info)),
      el('span', { class: `status status--${status}` }, statusTekst),
      el('div', { class: 'person__knapper' }, ...knapper));

    function knapp(tekst, handling, klasse) {
      const b = el('button', { type: 'button', class: klasse }, tekst);
      b.addEventListener('click', () => settStatus(p, handling, b));
      return b;
    }
  }

  async function settStatus(p, handling, knapp) {
    feil('');
    const rad = knapp.closest('li');
    for (const b of rad.querySelectorAll('button')) b.disabled = true;
    try {
      const svar = await api('status', { metode: 'POST', body: { personRef: p.personRef, stedId: state.sted.id, handling } });
      p.utTid = svar.utTid;
      p.innTid = svar.innTid;
      tegnListe();
    } catch (err) {
      haandter(err);
      for (const b of rad.querySelectorAll('button')) b.disabled = false;
    }
  }

  // ---------- Automatisk oppdatering ----------

  function startOppdatering() {
    stoppOppdatering();
    state.timer = setInterval(() => {
      if (document.visibilityState === 'visible') hentListe({ stille: true });
    }, OPPDATER_MS);
  }

  function stoppOppdatering() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  // ---------- Hendelser ----------

  $('epost-skjema').addEventListener('submit', sendKode);
  $('kode-skjema').addEventListener('submit', loggInn);
  $('ny-kode').addEventListener('click', () => { feil(''); vis('epost'); $('epost').focus(); });
  $('loggut').addEventListener('click', loggUt);
  $('sted-sok').addEventListener('input', tegnSteder);
  $('sted-liste').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) velgSted(state.meg.steder.find((s) => s.id === b.dataset.id));
  });
  $('bytt-sted').addEventListener('click', () => { lagre(stedNokkel(), ''); visSteder(); });
  $('sok').addEventListener('input', tegnListe);
  $('oppdater').addEventListener('click', () => hentListe());
  document.querySelector('.tellere').addEventListener('click', (e) => {
    const b = e.target.closest('.teller');
    if (!b) return;
    state.filter = state.filter === b.dataset.filter ? 'alle' : b.dataset.filter;
    tegnListe();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.sted && !$('vis-liste').hidden) hentListe({ stille: true });
  });

  start();
})();
