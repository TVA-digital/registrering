(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function vis(seksjon) {
    $('laster').hidden = true;
    $('innlogging').hidden = seksjon !== 'innlogging';
    $('oversikt').hidden = seksjon !== 'oversikt';
    if (seksjon === 'innlogging') $('passord').focus();
  }

  function feil(id, melding) {
    $(id).textContent = melding || '';
    $(id).hidden = !melding;
  }

  async function api(handling, { metode = 'GET', body } = {}) {
    const res = await fetch(`api.php?handling=${handling}`, {
      method: metode,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function lastOversikt() {
    feil('oversikt-feil', '');
    try {
      const { status, data } = await api('oversikt');
      if (status === 401) return vis('innlogging');
      if (status !== 200) throw new Error(data.feil || `HTTP ${status}`);

      $('totalt').textContent = data.totalt;
      $('siste').textContent = data.sistePamelding ? `Siste påmelding: ${data.sistePamelding}` : 'Ingen påmeldinger ennå.';
      const rader = data.perFylke.map((r) => {
        const tr = document.createElement('tr');
        const f = document.createElement('td');
        f.textContent = r.fylke;
        const n = document.createElement('td');
        n.className = 'tall';
        n.textContent = r.antall;
        tr.append(f, n);
        return tr;
      });
      if (!rader.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 2;
        td.textContent = 'Ingen påmeldinger ennå';
        tr.append(td);
        rader.push(tr);
      }
      $('fylker').replaceChildren(...rader);
      vis('oversikt');
    } catch (err) {
      console.error(err);
      vis('oversikt');
      feil('oversikt-feil', `Klarte ikke hente oversikten: ${err.message}`);
    }
  }

  $('logginn-skjema').addEventListener('submit', async (e) => {
    e.preventDefault();
    feil('logginn-feil', '');
    const knapp = $('logginn-knapp');
    knapp.disabled = true;
    try {
      const { status, data } = await api('logginn', { metode: 'POST', body: { passord: $('passord').value } });
      if (status === 200) {
        $('passord').value = '';
        await lastOversikt();
      } else {
        feil('logginn-feil', data.feil || 'Innloggingen feilet.');
      }
    } catch (err) {
      feil('logginn-feil', 'Fikk ikke kontakt med serveren. Prøv igjen.');
    } finally {
      knapp.disabled = false;
    }
  });

  $('oppdater').addEventListener('click', lastOversikt);
  $('loggut').addEventListener('click', async () => {
    try { await api('loggut', { metode: 'POST', body: {} }); } catch { /* logg ut lokalt uansett */ }
    vis('innlogging');
  });

  lastOversikt();
})();
