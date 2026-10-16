# Påmelding av bøssebærere – backup

Dette er en reserveløsning for påmelding av bøssebærere til NRK TV-aksjonen 18. oktober 2026. Den skal tas i bruk hvis påmeldingen i Aksjonsportalen går ned. Skjemaet følger det ordinære påmeldingsløpet i tre steg: forside, valg av oppmøtested og registreringsskjema, og til slutt en kvittering. Vipps-innlogging og «Finn nærmeste oppmøtested» er bevisst utelatt.

Påmeldingene lagres i backupens egen database og kan lastes ned som CSV fra `/admin`, slik at de kan legges inn i Aksjonsportalen når den er oppe igjen.

## Kom i gang lokalt

Du trenger Node.js 22.13 eller nyere.

```bash
npm install
ADMIN_PASSWORD='et-langt-passord' npm start
# → http://localhost:8080   (admin: http://localhost:8080/admin, bruker "admin")
```

Lokalt lagres påmeldingene i SQLite-fila `var/pameldinger.db`. Testene kjøres med `npm test`.

## Oppdatere oppmøtesteder

Oppmøtestedene ligger i `data/oppmotesteder.json`, som lages fra CSV-eksporten fra Aksjonsportalen:

```bash
npm run import -- ~/Downloads/Oppmøtesteder_26_10_09.csv
```

Scriptet tar bare med steder som er åpne og ikke skjult (bruk `--inkluder-stengte` for å få med stengte). Navn, e-post og telefon til oppmøteansvarlige tas bevisst ikke med, siden fila sendes ut offentlig til nettleseren. Rå CSV-filer er lagt i `.gitignore` og skal ikke sjekkes inn.

Kapasiteten regnes slik: Står «Automatisk stenging» på et sted, tar backupen imot påmeldinger til antall påmeldte i eksporten pluss påmeldingene i backupen når «Ønsket antall bøssebærere». Deretter vises stedet som fullt med «Fullt tilleggstekst». Steder uten automatisk stenging stenges aldri. Importer en fersk eksport rett før backupen aktiveres, så tallene stemmer best mulig.

## Drift på Vercel + Supabase (anbefalt)

Vercel serverer skjemaet og kjører API-et som serverløse funksjoner (`api/`). Supabase lagrer påmeldingene i Postgres. Begge har gratisnivå. Velg EU-regioner, så holdes dataene innenfor EØS: Supabase i Stockholm (`eu-north-1`), og Vercel-funksjonene står i Stockholm (`arn1`, satt i `vercel.json`).

### 1. Supabase

1. Opprett et prosjekt på [supabase.com](https://supabase.com). Velg regionen **North EU (Stockholm)** og et sterkt databasepassord.
2. Åpne **SQL Editor → New query**, lim inn hele `supabase/schema.sql` og trykk **Run**.
3. Hent to verdier under **Project Settings → API Keys / Data API**: prosjekt-URL-en (`https://<ref>.supabase.co`) og **service role**-nøkkelen (eller en *secret key*, `sb_secret_…`).

Tabellene har Row Level Security uten policyer, og rollene `anon` og `authenticated` har ingen rettigheter. Bare Vercel-funksjonene, med service role-nøkkelen, kan lese og skrive. Den offentlige anon-nøkkelen brukes ikke i det hele tatt. Unik e-post, kapasitet per oppmøtested og rate limiting håndheves i databasefunksjoner i én transaksjon.

### 2. Vercel

1. Gå til [vercel.com/new](https://vercel.com/new) og importer GitHub-repoet `TVA-digital/registrering` (velg branchen med koden, eller merge den til `main` først). Alle innstillinger hentes fra `vercel.json`, så du trenger ikke endre noe der.
2. Legg inn disse under **Environment Variables** før du trykker **Deploy**:

| Variabel | Verdi |
|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service role- eller secret-nøkkelen. Den er hemmelig og skal bare inn her |
| `ADMIN_PASSWORD` | passord til `/admin`, minst 12 tegn |
| `PRIVACY_URL` | valgfritt: lenken til personvernerklæringen |

3. Etter deploy finner du påmeldingen på `https://<prosjekt>.vercel.app` og admin på `https://<prosjekt>.vercel.app/admin`. Eget domene kan legges til under **Settings → Domains**.

Bruker dere Vercels Hobby-plan, må den siste commiten på branchen være laget av samme GitHub-konto som eier Vercel-kontoen. Ellers avviser Vercel deployen.

Svaret fra `/api/oppmotesteder` caches i 15 sekunder i Vercels CDN, så databasen tåler stor pågang. Vercels Hobby-plan er bare for ikke-kommersiell bruk. For en organisasjon bør dere bruke Pro-planen, eller sjekke vilkårene for ideelle organisasjoner.

### Teste Vercel-oppsettet lokalt

```bash
ADMIN_PASSWORD='et-langt-passord' npm run vercel:lokal          # SQLite i var/
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ADMIN_PASSWORD=… npm run vercel:lokal   # mot Supabase
```

## Webhotell med PHP

Har dere et vanlig webhotell med PHP, for eksempel Domeneshop, One.com eller Webhuset, kan løsningen lastes opp som filer. Den trenger ingen Node.js og ingen egen server.

```bash
node scripts/bygg-php.js     # → dist/pamelding-backup.zip
```

Zip-fila har `index.html` (påmeldingen), `admin.html` (oversikt og CSV-eksport), `api.php`, `config.php` og `sjekk.php`. Den inneholder også en `data/`-mappe som er sperret med `.htaccess`. Der havner SQLite-databasen, med et tilfeldig filnavn. Fremgangsmåten står i `LES-MEG.txt`:

1. Bytt passordet i `config.php`.
2. Last opp mappen.
3. Åpne `sjekk.php`, og slett den når alt er grønt.

Krav: PHP 7.4 eller nyere med `pdo_sqlite`, Apache med `.htaccess`, og HTTPS. Kildefilene ligger i `php/`.

## Drift på Google Cloud

Løsningen er laget for Cloud Run med Firestore som database. Den skalerer automatisk ved stor pågang. Unik e-post og kapasitet per oppmøtested håndheves i én Firestore-transaksjon, så det holder også med mange instanser samtidig.

```bash
gcloud auth login
PROJECT_ID=<gcp-prosjekt-id> ./deploy-cloudrun.sh
```

Scriptet gjør dette:

1. Aktiverer API-ene som trengs.
2. Oppretter Firestore i `europe-north1`.
3. Lager et admin-passord i Secret Manager og skriver det ut én gang.
4. Gir Cloud Run-tjenesten tilgang til Firestore og hemmeligheten.
5. Bygger og deployer. Til slutt skriver det ut URL-en.

`--min-instances 1` gjør at tjenesten svarer raskt med en gang. Den koster noen kroner i døgnet, så sett den til 0 etter aksjonen.

Det er lurt å koble tjenesten til et eget domene, for eksempel `backup.tvaksjonen.no`. Det kan gjøres med Cloud Run domain mapping eller en load balancer, slik at lenken er klar til å deles hvis hovedsystemet faller ut.

## Drift på egen server

Med `STORAGE=sqlite` (standard) kjører løsningen på hvilken som helst VM eller container med persistent disk. Bruk ikke SQLite på Cloud Run, for disken der slettes ved hver omstart.

```bash
docker build -t pamelding-backup .
docker run -p 8080:8080 -v pamelding-data:/app/var -e ADMIN_PASSWORD='…' pamelding-backup
```

## Konfigurasjon

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `PORT` | `8080` | Port serveren lytter på |
| `STORAGE` | `sqlite` | `sqlite`, `supabase` eller `firestore` (Vercel-funksjonene bruker `supabase`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | – | Tilkobling til Supabase |
| `SQLITE_FILE` | `var/pameldinger.db` | Databasefil for SQLite |
| `GOOGLE_CLOUD_PROJECT` | – | GCP-prosjekt for Firestore (settes automatisk på Cloud Run) |
| `FIRESTORE_DATABASE` | `(default)` | Navn på Firestore-database |
| `FIRESTORE_PREFIX` | – | Prefiks på samlingsnavn, nyttig for test i samme prosjekt |
| `ADMIN_PASSWORD` | – | Passord for `/admin` og CSV-eksport. Uten dette er admin slått av |
| `PRIVACY_URL` | `https://www.tvaksjonen.no/personvern` | Lenken til retningslinjene for personvern |
| `AKSJONSAR` | `2026` | Brukes til aldersgrensen (15 år) |
| `TRUST_PROXY` | `1` | Antall proxyer foran appen (for riktig IP i rate limiting) |

## Sikkerhet og personvern

Skjemaet valideres både i nettleseren og på serveren. Det har en usynlig «honningkrukke» mot roboter og en begrensning på 10 innsendinger per minutt per IP. Hver e-postadresse kan bare brukes én gang, uansett store eller små bokstaver. Serveren sender med en streng Content-Security-Policy. Admin er beskyttet med Basic Auth over HTTPS, og CSV-eksporten er sikret mot formel-injeksjon i Excel.

Backupen lagrer navn, e-post, telefon og fødselsår, og at personen har samtykket. Slett databasen når påmeldingene er overført til Aksjonsportalen. I Firestore sletter du samlingene `registreringer`, `epostindeks` og `tellere`. I Supabase kjører du `truncate public.registreringer, public.forsok;` i SQL Editor, eller sletter hele prosjektet.

## Struktur

```
server.js                     oppstart og graceful shutdown
src/app.js                    Express-app: API, admin, statiske filer
src/validering.js             validering og normalisering av påmeldinger
src/storage/sqlite.js         lagring for én server / lokalt
src/storage/firestore.js      lagring for Cloud Run
src/storage/supabase.js       lagring i Supabase
src/vercel.js, api/           Vercel-funksjoner (oppmøtesteder, påmelding, admin)
supabase/schema.sql           tabeller, tilgangsstyring og databasefunksjoner
php/                          PHP-versjon for webhotell
public/                       frontend (index.html, styles.css, app.js, bilder)
scripts/import-oppmotesteder.js   CSV → data/oppmotesteder.json
```

Bildene i `public/img` er klippet ut fra skjermbilder av dagens påmelding. Bytt dem gjerne ut med originalfilene i høyere oppløsning fra kampanjematerialet, med samme filnavn og samme utsnitt.
