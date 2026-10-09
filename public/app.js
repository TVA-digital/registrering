(() => {
  'use strict';

  const AKSJONSAR = 2026;
  const SISTE_GYLDIGE_FODSELSAR = AKSJONSAR - 15;
  const VIEWS = ['start', 'sted', 'skjema', 'takk'];
  const FELT = ['fornavn', 'etternavn', 'epost', 'telefon', 'fodselsar'];

  const $ = (id) => document.getElementById(id);
  const collator = new Intl.Collator('nb');

  const state = {
    steder: [],
    stedMap: new Map(),
    lastet: false,
    lasting: null,
    valgtStedId: lesLagret('valgtStedId'),
    kvittering: null,
  };

  // ---------- Hjelpere ----------

  function lesLagret(k) {
    try { return sessionStorage.getItem(k) || ''; } catch { return ''; }
  }
  function lagre(k, v) {
    try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* privat modus o.l. */ }
  }

  function settAlternativer(select, verdier, { tekst = (v) => v, verdi = (v) => v } = {}) {
    select.replaceChildren(new Option('', '', true, true));
    select.options[0].disabled = true;
    for (const v of verdier) select.add(new Option(tekst(v), verdi(v)));
    select.disabled = verdier.length === 0;
  }

  function unike(liste) {
    return [...new Set(liste)].sort(collator.compare);
  }

  async function hentJson(url, opts = {}, forsok = 3) {
    let sisteFeil;
    for (let i = 0; i < forsok; i++) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
        if (res.status >= 500 && i < forsok - 1) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        sisteFeil = err;
        if (i < forsok - 1) await new Promise((r) => setTimeout(r, 600 * 2 ** i));
      }
    }
    throw sisteFeil;
  }

  // ---------- Navigasjon ----------

  function gaaTil(view, { erstatt = false } = {}) {
    const hash = view === 'start' ? '#/' : `#/${view}`;
    if (location.hash !== hash) {
      erstatt ? history.replaceState(null, '', hash) : history.pushState(null, '', hash);
    }
    visView();
  }

  function visView() {
    let view = (location.hash.replace(/^#\/?/, '') || 'start').split('?')[0];
    if (!VIEWS.includes(view)) view = 'start';
    if (view === 'skjema' && !state.valgtStedId) view = 'sted';
    if (view === 'takk' && !state.kvittering) view = 'start';

    for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
    window.scrollTo(0, 0);

    if (view === 'sted') lastSteder();
    if (view === 'skjema') oppdaterSendKnapp();
    if (view === 'takk') visKvittering();

    const tittel = { start: 'Bli bøssebærer', sted: 'Velg oppmøtested', skjema: 'Registrer deg', takk: 'Takk!' }[view];
    document.title = `${tittel} – NRK TV-aksjonen`;
  }

  // ---------- View 2: oppmøtested ----------

  async function lastSteder() {
    if (state.lastet) return;
    if (state.lasting) return state.lasting;

    const feil = $('sted-lastefeil');
    feil.hidden = true;
    $('fylke').disabled = true;

    state.lasting = (async () => {
      try {
        const res = await hentJson('/api/oppmotesteder');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const steder = await res.json();
        if (!Array.isArray(steder) || steder.length === 0) throw new Error('Tom liste');
        state.steder = steder;
        state.stedMap = new Map(steder.map((s) => [s.id, s]));
        state.lastet = true;
        byggFylker();
      } catch (err) {
        console.error('Klarte ikke laste oppmøtesteder', err);
        feil.textContent = 'Vi klarte ikke å hente oppmøtestedene akkurat nå. Sjekk nettforbindelsen og last siden på nytt.';
        feil.hidden = false;
      } finally {
        state.lasting = null;
      }
    })();
    return state.lasting;
  }

  function byggFylker() {
    settAlternativer($('fylke'), unike(state.steder.map((s) => s.fylke)));
    settAlternativer($('kommune'), []);
    settAlternativer($('sted'), []);

    // Gjenopprett tidligere valg (f.eks. når man går tilbake fra skjemaet)
    const valgt = state.stedMap.get(state.valgtStedId);
    if (valgt) {
      $('fylke').value = valgt.fylke;
      byggKommuner();
      $('kommune').value = valgt.kommune;
      byggSteder();
      $('sted').value = valgt.id;
    } else {
      state.valgtStedId = '';
    }
    visDetaljer();
  }

  function byggKommuner() {
    const fylke = $('fylke').value;
    settAlternativer($('kommune'), unike(state.steder.filter((s) => s.fylke === fylke).map((s) => s.kommune)));
    settAlternativer($('sted'), []);
  }

  function byggSteder() {
    const fylke = $('fylke').value;
    const kommune = $('kommune').value;
    const liste = state.steder
      .filter((s) => s.fylke === fylke && s.kommune === kommune)
      .sort((a, b) => collator.compare(a.navn, b.navn));
    settAlternativer($('sted'), liste, {
      tekst: (s) => (s.fullt ? `${s.navn} (fullt)` : s.navn),
      verdi: (s) => s.id,
    });
  }

  function visDetaljer() {
    const sted = state.stedMap.get($('sted').value);
    const boks = $('sted-detaljer');
    const knapp = $('til-skjema');

    if (!sted) {
      boks.hidden = true;
      knapp.disabled = true;
      state.valgtStedId = '';
      lagre('valgtStedId', '');
      return;
    }

    $('d-tid').textContent = sted.tid || 'Ikke oppgitt';
    $('d-adresse').textContent = sted.adresse || 'Ikke oppgitt';
    $('d-tilgj').textContent = sted.tilgjengelighet;
    $('d-tilgj-blokk').hidden = !sted.tilgjengelighet;

    const fullt = $('d-fullt');
    fullt.hidden = !sted.fullt;
    fullt.textContent = sted.fullt
      ? sted.fulltTekst || 'Dette oppmøtestedet er dessverre fullt. Velg gjerne et annet oppmøtested i nærheten.'
      : '';

    boks.hidden = false;
    knapp.disabled = sted.fullt;
    state.valgtStedId = sted.fullt ? '' : sted.id;
    lagre('valgtStedId', state.valgtStedId);
  }

  // ---------- View 3: skjema ----------

  function valider(felt, verdi) {
    const v = verdi.trim();
    switch (felt) {
      case 'fornavn':
      case 'etternavn':
        if (!v) return `${felt === 'fornavn' ? 'Fornavn' : 'Etternavn'} må fylles ut.`;
        if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(v)) return 'Inneholder ugyldige tegn.';
        return '';
      case 'epost':
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Skriv inn en gyldig e-postadresse.';
      case 'telefon': {
        let s = v.replace(/[\s().-]/g, '');
        if (s.startsWith('00')) s = '+' + s.slice(2);
        return /^(\+47)?\d{8}$/.test(s) || /^\+\d{8,15}$/.test(s) ? '' : 'Skriv inn et gyldig telefonnummer (8 siffer).';
      }
      case 'fodselsar': {
        if (!/^\d{4}$/.test(v) || Number(v) < 1900) return 'Skriv inn fødselsår med fire siffer.';
        if (Number(v) > SISTE_GYLDIGE_FODSELSAR) return 'Du må være 15 år eller eldre for å registrere deg.';
        return '';
      }
      default:
        return '';
    }
  }

  function settFeltFeil(felt, melding) {
    const input = $(felt);
    const p = $(`${felt}-feil`);
    if (!input || !p) return;
    input.setAttribute('aria-invalid', melding ? 'true' : 'false');
    p.textContent = melding;
    p.hidden = !melding;
    if ($(`${felt}-hjelp`)) $(`${felt}-hjelp`).hidden = Boolean(melding);
    const beskrevet = [`${felt}-hjelp`, `${felt}-feil`].filter((id) => $(id) && !$(id).hidden);
    beskrevet.length ? input.setAttribute('aria-describedby', beskrevet.join(' ')) : input.removeAttribute('aria-describedby');
  }

  function oppdaterSendKnapp() {
    const utfylt = FELT.every((f) => $(f).value.trim() !== '') && $('samtykke').checked;
    $('send').disabled = !utfylt || $('send').getAttribute('aria-busy') === 'true';
  }

  function visSkjemaFeil(melding) {
    const boks = $('skjema-feil');
    boks.textContent = melding;
    boks.hidden = !melding;
    if (melding) boks.focus();
  }

  async function sendInn(e) {
    e.preventDefault();
    visSkjemaFeil('');

    let forsteFeil = null;
    for (const f of FELT) {
      const melding = valider(f, $(f).value);
      settFeltFeil(f, melding);
      if (melding && !forsteFeil) forsteFeil = f;
    }
    if (forsteFeil) {
      $(forsteFeil).focus();
      return;
    }
    if (!$('samtykke').checked) {
      visSkjemaFeil('Du må samtykke til behandling av personopplysninger.');
      return;
    }
    if (!state.valgtStedId) {
      gaaTil('sted');
      return;
    }

    const knapp = $('send');
    knapp.setAttribute('aria-busy', 'true');
    knapp.disabled = true;
    knapp.textContent = 'Registrerer …';

    try {
      const res = await fetch('/api/registrering', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          fornavn: $('fornavn').value,
          etternavn: $('etternavn').value,
          epost: $('epost').value,
          telefon: $('telefon').value,
          fodselsar: $('fodselsar').value,
          samtykke: $('samtykke').checked,
          stedId: state.valgtStedId,
          nettside: $('nettside').value,
        }),
      });
      const svar = await res.json().catch(() => ({}));

      if (res.ok) {
        const sted = svar.sted || {};
        state.kvittering = { fornavn: $('fornavn').value.trim(), stedNavn: sted.navn, tid: sted.tid, adresse: sted.adresse };
        $('skjema').reset();
        FELT.forEach((f) => settFeltFeil(f, ''));
        state.valgtStedId = '';
        lagre('valgtStedId', '');
        state.lastet = false; // hent ferske tall neste gang
        gaaTil('takk', { erstatt: true });
        return;
      }

      if (svar.kode === 'sted_fullt') {
        state.lastet = false;
        visSkjemaFeil(`${svar.feil} Gå tilbake og velg et annet oppmøtested.`);
      } else if (svar.felt && FELT.includes(svar.felt)) {
        settFeltFeil(svar.felt, svar.feil);
        $(svar.felt).focus();
      } else {
        visSkjemaFeil(svar.feil || 'Noe gikk galt. Prøv igjen om litt.');
      }
    } catch (err) {
      console.error('Innsending feilet', err);
      visSkjemaFeil('Vi fikk ikke kontakt med serveren. Sjekk nettforbindelsen og prøv igjen – påmeldingen er ikke lagret.');
    } finally {
      knapp.removeAttribute('aria-busy');
      knapp.textContent = 'Registrer deg';
      oppdaterSendKnapp();
    }
  }

  // ---------- Kvittering ----------

  function visKvittering() {
    const k = state.kvittering || {};
    $('t-navn').textContent = k.fornavn || '';
    $('t-sted').textContent = k.stedNavn || '';
    $('t-tid').textContent = k.tid || '';
    $('t-adresse').textContent = k.adresse || '';
    $('takk-tittel').focus();
  }

  // ---------- Oppstart ----------

  function init() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-gaa]');
      if (el) {
        e.preventDefault();
        gaaTil(el.dataset.gaa);
      }
    });

    $('fylke').addEventListener('change', () => { byggKommuner(); visDetaljer(); });
    $('kommune').addEventListener('change', () => { byggSteder(); visDetaljer(); });
    $('sted').addEventListener('change', visDetaljer);
    $('til-skjema').addEventListener('click', () => state.valgtStedId && gaaTil('skjema'));

    $('skjema').addEventListener('input', (e) => {
      if (FELT.includes(e.target.id) && e.target.getAttribute('aria-invalid') === 'true') {
        settFeltFeil(e.target.id, valider(e.target.id, e.target.value));
      }
      oppdaterSendKnapp();
    });
    $('skjema').addEventListener('change', oppdaterSendKnapp);
    // Feltene valideres ved innsending (ikke ved focusout): en feilmelding som dukker opp idet feltet
    // mister fokus, flytter innholdet under og kan gjøre at klikket på neste element går tapt.
    $('skjema').addEventListener('submit', sendInn);

    window.addEventListener('popstate', visView);
    window.addEventListener('hashchange', visView);

    fetch('/api/konfig')
      .then((r) => (r.ok ? r.json() : null))
      .then((k) => { if (k && /^https:\/\//.test(k.personvernUrl)) $('personvern-lenke').href = k.personvernUrl; })
      .catch(() => { /* standardlenken i HTML brukes */ });

    visView();
    lastSteder(); // forhåndslast mens brukeren leser forsiden
  }

  init();
})();
