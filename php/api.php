<?php
/**
 * API for backup-påmelding av bøssebærere (PHP-versjon for webhotell).
 * Krever PHP 7.4+ med PDO SQLite.
 *
 *   GET  api.php?handling=oppmotesteder
 *   GET  api.php?handling=konfig
 *   POST api.php?handling=registrering
 *   POST api.php?handling=logginn | loggut      (admin)
 *   GET  api.php?handling=oversikt | eksport    (admin, krever innlogging)
 */
declare(strict_types=1);

const MINSTEALDER = 15;
const TIDSSONE = 'Europe/Oslo';
const STANDARDPASSORD = 'BYTT-MEG';

final class ApiFeil extends Exception
{
    public $status;
    public $kode;
    public $felt;

    public function __construct(int $status, string $kode, string $melding, ?string $felt = null)
    {
        parent::__construct($melding);
        $this->status = $status;
        $this->kode = $kode;
        $this->felt = $felt;
    }
}

function svar(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function konfig(): array
{
    static $k = null;
    if ($k === null) {
        $k = require __DIR__ . '/config.php';
        if (!is_array($k)) {
            throw new RuntimeException('config.php returnerer ikke en liste med innstillinger');
        }
    }
    return $k;
}

function datamappe(): string
{
    return rtrim((string) konfig()['datamappe'], '/\\');
}

// ---------- Database ----------

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $mappe = datamappe();
    if (!is_dir($mappe) && !mkdir($mappe, 0750, true)) {
        throw new RuntimeException("Kan ikke opprette datamappen $mappe");
    }

    // Databasefila får et tilfeldig navn ved første kjøring, så den ikke kan gjettes.
    $navnefil = $mappe . '/.dbnavn.php';
    if (!is_file($navnefil)) {
        $navn = 'pameldinger-' . bin2hex(random_bytes(12)) . '.sqlite';
        if (file_put_contents($navnefil, "<?php return '$navn';\n", LOCK_EX) === false) {
            throw new RuntimeException("Kan ikke skrive til datamappen $mappe");
        }
    }
    $fil = $mappe . '/' . (require $navnefil);

    $pdo = new PDO('sqlite:' . $fil, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('
        CREATE TABLE IF NOT EXISTS registreringer (
            id         TEXT PRIMARY KEY,
            opprettet  TEXT NOT NULL,
            fornavn    TEXT NOT NULL,
            etternavn  TEXT NOT NULL,
            epost      TEXT NOT NULL UNIQUE,
            telefon    TEXT NOT NULL,
            fodselsar  INTEGER NOT NULL,
            sted_id    TEXT NOT NULL,
            samtykke   INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_reg_sted ON registreringer(sted_id);
        CREATE TABLE IF NOT EXISTS forsok (nokkel TEXT NOT NULL, tid INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_forsok ON forsok(nokkel, tid);
    ');
    @chmod($fil, 0640);
    return $pdo;
}

function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

// ---------- Oppmøtesteder ----------

function steder(): array
{
    static $map = null;
    if ($map !== null) {
        return $map;
    }
    $fil = datamappe() . '/oppmotesteder.json';
    $raw = @file_get_contents($fil);
    $data = $raw === false ? null : json_decode($raw, true);
    if (!is_array($data) || empty($data['steder'])) {
        throw new RuntimeException("Fant ingen oppmøtesteder i $fil");
    }
    $map = [];
    foreach ($data['steder'] as $s) {
        $map[$s['id']] = $s;
    }
    return $map;
}

function formaterTid(?string $iso): string
{
    if (!$iso) {
        return '';
    }
    try {
        $d = new DateTime($iso);
        $d->setTimezone(new DateTimeZone(TIDSSONE));
        return $d->format('d.m.Y') . ', kl. ' . $d->format('H:i');
    } catch (Exception $e) {
        return '';
    }
}

function adresse(array $s): string
{
    $post = trim(($s['postnr'] ?? '') . ' ' . ($s['poststed'] ?? ''));
    return implode(', ', array_filter([$s['gate'] ?? '', $post], 'strlen'));
}

function maksForBackup(array $s): ?int
{
    if (empty($s['autoStenging']) || !isset($s['onsket'])) {
        return null;
    }
    return max(0, (int) $s['onsket'] - (int) ($s['pameldtHovedsystem'] ?? 0));
}

function antallPerSted(): array
{
    $m = [];
    foreach (db()->query('SELECT sted_id, COUNT(*) AS n FROM registreringer GROUP BY sted_id') as $r) {
        $m[$r['sted_id']] = (int) $r['n'];
    }
    return $m;
}

// ---------- Validering ----------

function tekst($verdi, string $felt, string $etikett, int $maks): string
{
    $s = is_string($verdi) ? $verdi : '';
    if (class_exists('Normalizer')) {
        $s = (string) Normalizer::normalize($s, Normalizer::FORM_C);
    }
    $s = trim((string) preg_replace('/\s+/u', ' ', $s));
    if ($s === '') {
        throw new ApiFeil(400, 'ugyldig', "$etikett må fylles ut.", $felt);
    }
    if (mb_strlen($s, 'UTF-8') > $maks) {
        throw new ApiFeil(400, 'ugyldig', "$etikett kan ikke være lengre enn $maks tegn.", $felt);
    }
    return $s;
}

function normaliserTelefon(string $raw): ?string
{
    $s = (string) preg_replace('/[\s().-]/', '', $raw);
    if (strpos($s, '00') === 0) {
        $s = '+' . substr($s, 2);
    }
    if (preg_match('/^\+47\d{8}$/', $s)) {
        return substr($s, 3);
    }
    if (preg_match('/^\d{8}$/', $s) || preg_match('/^\+\d{8,15}$/', $s)) {
        return $s;
    }
    return null;
}

function validerPamelding($b): array
{
    if (!is_array($b)) {
        throw new ApiFeil(400, 'ugyldig', 'Ugyldig forespørsel.');
    }
    $navnRe = "/^[\\p{L}\\p{M}][\\p{L}\\p{M} .'’-]*$/u";

    $fornavn = tekst($b['fornavn'] ?? null, 'fornavn', 'Fornavn', 60);
    if (!preg_match($navnRe, $fornavn)) {
        throw new ApiFeil(400, 'ugyldig', 'Fornavn inneholder ugyldige tegn.', 'fornavn');
    }
    $etternavn = tekst($b['etternavn'] ?? null, 'etternavn', 'Etternavn', 60);
    if (!preg_match($navnRe, $etternavn)) {
        throw new ApiFeil(400, 'ugyldig', 'Etternavn inneholder ugyldige tegn.', 'etternavn');
    }
    $epost = mb_strtolower(tekst($b['epost'] ?? null, 'epost', 'E-postadresse', 254), 'UTF-8');
    if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u', $epost)) {
        throw new ApiFeil(400, 'ugyldig', 'Skriv inn en gyldig e-postadresse.', 'epost');
    }
    $telefon = normaliserTelefon(tekst($b['telefon'] ?? null, 'telefon', 'Telefonnummer', 20));
    if ($telefon === null) {
        throw new ApiFeil(400, 'ugyldig', 'Skriv inn et gyldig telefonnummer (8 siffer).', 'telefon');
    }
    $ar = trim((string) ($b['fodselsar'] ?? ''));
    if (!preg_match('/^\d{4}$/', $ar) || (int) $ar < 1900) {
        throw new ApiFeil(400, 'ugyldig', 'Skriv inn fødselsår med fire siffer.', 'fodselsar');
    }
    $sisteGyldige = (int) konfig()['aksjonsar'] - MINSTEALDER;
    if ((int) $ar > $sisteGyldige) {
        throw new ApiFeil(400, 'ugyldig', 'Du må være ' . MINSTEALDER . ' år eller eldre for å registrere deg.', 'fodselsar');
    }
    if (($b['samtykke'] ?? null) !== true) {
        throw new ApiFeil(400, 'ugyldig', 'Du må samtykke til behandling av personopplysninger.', 'samtykke');
    }
    $stedId = is_string($b['stedId'] ?? null) ? trim($b['stedId']) : '';
    if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $stedId)) {
        throw new ApiFeil(400, 'ugyldig', 'Velg et oppmøtested.', 'stedId');
    }
    return compact('fornavn', 'etternavn', 'epost', 'telefon', 'stedId') + ['fodselsar' => (int) $ar];
}

// ---------- Rate limiting ----------

function begrens(string $type, int $maks, int $vindu = 60): void
{
    $nokkel = $type . ':' . hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? 'ukjent') . '|' . __FILE__);
    $na = time();
    $pdo = db();
    $pdo->prepare('DELETE FROM forsok WHERE tid < ?')->execute([$na - 3600]);
    $st = $pdo->prepare('SELECT COUNT(*) FROM forsok WHERE nokkel = ? AND tid > ?');
    $st->execute([$nokkel, $na - $vindu]);
    if ((int) $st->fetchColumn() >= $maks) {
        header('Retry-After: ' . $vindu);
        throw new ApiFeil(429, 'for_mange', 'For mange forsøk. Vent litt og prøv igjen.');
    }
    $pdo->prepare('INSERT INTO forsok (nokkel, tid) VALUES (?, ?)')->execute([$nokkel, $na]);
}

// ---------- Hjelpere for forespørsler ----------

function lesJson(): array
{
    $type = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($type, 'application/json') !== 0) {
        throw new ApiFeil(415, 'ugyldig', 'Forventet JSON.');
    }
    $raw = file_get_contents('php://input', false, null, 0, 10241);
    if ($raw === false || strlen($raw) > 10240) {
        throw new ApiFeil(400, 'ugyldig', 'Ugyldig forespørsel.');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new ApiFeil(400, 'ugyldig', 'Ugyldig forespørsel.');
    }
    return $data;
}

function krevMetode(string $metode): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== $metode) {
        header('Allow: ' . $metode);
        throw new ApiFeil(405, 'ugyldig', 'Metoden er ikke tillatt.');
    }
}

function startSesjon(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('pamelding_admin');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => dirname($_SERVER['SCRIPT_NAME'] ?? '/') ?: '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function krevAdmin(): void
{
    startSesjon();
    if (empty($_SESSION['admin']) || ($_SESSION['utloper'] ?? 0) < time()) {
        throw new ApiFeil(401, 'ikke_innlogget', 'Du må logge inn.');
    }
    $_SESSION['utloper'] = time() + 3600;
}

function csvCelle($v): string
{
    $s = $v === null ? '' : (string) $v;
    if (preg_match('/^[=+\-@\t\r]/', $s)) {
        $s = "'" . $s; // hindrer formel-injeksjon i Excel
    }
    return preg_match('/[";\n\r]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
}

// ---------- Handlinger ----------

function handlingOppmotesteder(): void
{
    try {
        $antall = antallPerSted();
    } catch (Throwable $e) {
        error_log('Påmelding: klarte ikke telle påmeldte: ' . $e->getMessage());
        $antall = [];
    }
    $ut = [];
    foreach (steder() as $s) {
        $maks = maksForBackup($s);
        $ut[] = [
            'id' => $s['id'],
            'navn' => $s['navn'],
            'fylke' => $s['fylke'],
            'kommune' => $s['kommune'],
            'adresse' => adresse($s),
            'tid' => formaterTid($s['tid'] ?? null),
            'tilgjengelighet' => $s['tilgjengelighet'] ?? '',
            'fullt' => $maks !== null && ($antall[$s['id']] ?? 0) >= $maks,
            'fulltTekst' => $s['fulltTekst'] ?? '',
        ];
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: public, max-age=15');
    echo json_encode($ut, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function handlingRegistrering(): void
{
    krevMetode('POST');
    begrens('reg', (int) (konfig()['maks_per_minutt'] ?? 10));
    $b = lesJson();

    // Honningkrukke: usynlig felt som bare roboter fyller ut
    if (is_string($b['nettside'] ?? null) && trim($b['nettside']) !== '') {
        svar(201, ['ok' => true]);
    }

    $reg = validerPamelding($b);
    $steder = steder();
    if (!isset($steder[$reg['stedId']])) {
        throw new ApiFeil(400, 'ugyldig', 'Oppmøtestedet finnes ikke.', 'stedId');
    }
    $sted = $steder[$reg['stedId']];
    $maks = maksForBackup($sted);

    $pdo = db();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $st = $pdo->prepare('SELECT 1 FROM registreringer WHERE epost = ?');
        $st->execute([$reg['epost']]);
        if ($st->fetchColumn()) {
            throw new ApiFeil(409, 'epost_brukt', 'Denne e-postadressen er allerede registrert. En e-postadresse kan kun brukes én gang.', 'epost');
        }
        if ($maks !== null) {
            $st = $pdo->prepare('SELECT COUNT(*) FROM registreringer WHERE sted_id = ?');
            $st->execute([$reg['stedId']]);
            if ((int) $st->fetchColumn() >= $maks) {
                $tekst = $sted['fulltTekst'] ?: 'Oppmøtestedet er dessverre fullt. Velg gjerne et annet oppmøtested.';
                throw new ApiFeil(409, 'sted_fullt', $tekst, 'stedId');
            }
        }
        $pdo->prepare('INSERT INTO registreringer
            (id, opprettet, fornavn, etternavn, epost, telefon, fodselsar, sted_id, samtykke)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
            ->execute([uuid(), gmdate('Y-m-d\TH:i:s\Z'), $reg['fornavn'], $reg['etternavn'], $reg['epost'],
                $reg['telefon'], $reg['fodselsar'], $reg['stedId']]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        if ($e instanceof PDOException && stripos($e->getMessage(), 'UNIQUE') !== false) {
            throw new ApiFeil(409, 'epost_brukt', 'Denne e-postadressen er allerede registrert. En e-postadresse kan kun brukes én gang.', 'epost');
        }
        throw $e;
    }

    svar(201, ['ok' => true, 'sted' => [
        'navn' => $sted['navn'],
        'adresse' => adresse($sted),
        'tid' => formaterTid($sted['tid'] ?? null),
    ]]);
}

function handlingLogginn(): void
{
    krevMetode('POST');
    $riktig = (string) (konfig()['admin_passord'] ?? '');
    if ($riktig === '' || $riktig === STANDARDPASSORD || (strpos($riktig, '$2y$') !== 0 && strlen($riktig) < 12)) {
        throw new ApiFeil(503, 'ikke_konfigurert', 'Admin-passordet er ikke satt. Bytt "admin_passord" i config.php til minst 12 tegn.');
    }
    begrens('login', 5);
    $passord = (string) (lesJson()['passord'] ?? '');
    $ok = strpos($riktig, '$2y$') === 0 ? password_verify($passord, $riktig) : hash_equals($riktig, $passord);
    if (!$ok) {
        throw new ApiFeil(401, 'feil_passord', 'Feil passord.');
    }
    startSesjon();
    session_regenerate_id(true);
    $_SESSION['admin'] = true;
    $_SESSION['utloper'] = time() + 3600;
    svar(200, ['ok' => true]);
}

function handlingLoggut(): void
{
    krevMetode('POST');
    startSesjon();
    $_SESSION = [];
    session_destroy();
    svar(200, ['ok' => true]);
}

function handlingOversikt(): void
{
    krevAdmin();
    $steder = steder();
    $perFylke = [];
    $totalt = 0;
    foreach (antallPerSted() as $id => $n) {
        $fylke = $steder[$id]['fylke'] ?? 'Ukjent';
        $perFylke[$fylke] = ($perFylke[$fylke] ?? 0) + $n;
        $totalt += $n;
    }
    arsort($perFylke);
    $siste = db()->query('SELECT MAX(opprettet) FROM registreringer')->fetchColumn();
    svar(200, [
        'totalt' => $totalt,
        'perFylke' => array_map(function ($f, $n) { return ['fylke' => $f, 'antall' => $n]; },
            array_keys($perFylke), array_values($perFylke)),
        'sistePamelding' => $siste ? formaterTid($siste) : null,
    ]);
}

function handlingEksport(): void
{
    krevAdmin();
    $steder = steder();
    $hode = ['Registrert', 'Fornavn', 'Etternavn', 'E-post', 'Telefon', 'Fødselsår', 'Fylke', 'Kommune',
        'Oppmøtested', 'Oppmøtested-ID', 'Adresse', 'Oppmøtetid', 'Samtykke'];
    $linjer = [implode(';', $hode)];
    foreach (db()->query('SELECT * FROM registreringer ORDER BY opprettet') as $r) {
        $s = $steder[$r['sted_id']] ?? [];
        $linjer[] = implode(';', array_map('csvCelle', [
            formaterTid($r['opprettet']), $r['fornavn'], $r['etternavn'], $r['epost'], $r['telefon'],
            $r['fodselsar'], $s['fylke'] ?? '', $s['kommune'] ?? '', $s['navn'] ?? '', $r['sted_id'],
            $s ? adresse($s) : '', formaterTid($s['tid'] ?? null), $r['samtykke'] ? 'Ja' : 'Nei',
        ]));
    }
    $stempel = (new DateTime('now', new DateTimeZone(TIDSSONE)))->format('Y-m-d-H-i');
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="pameldinger-backup-' . $stempel . '.csv"');
    header('Cache-Control: no-store');
    echo "\xEF\xBB\xBF" . implode("\r\n", $linjer) . "\r\n";
    exit;
}

// ---------- Ruting ----------

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Frame-Options: DENY');

$handlinger = [
    'oppmotesteder' => 'handlingOppmotesteder',
    'registrering' => 'handlingRegistrering',
    'logginn' => 'handlingLogginn',
    'loggut' => 'handlingLoggut',
    'oversikt' => 'handlingOversikt',
    'eksport' => 'handlingEksport',
];

try {
    $handling = (string) ($_GET['handling'] ?? '');
    if ($handling === 'konfig') {
        svar(200, ['personvernUrl' => (string) (konfig()['personvern_url'] ?? '')]);
    }
    if (!isset($handlinger[$handling])) {
        throw new ApiFeil(404, 'ikke_funnet', 'Fant ikke ressursen.');
    }
    $handlinger[$handling]();
} catch (ApiFeil $e) {
    $data = ['kode' => $e->kode, 'feil' => $e->getMessage()];
    if ($e->felt !== null) {
        $data['felt'] = $e->felt;
    }
    svar($e->status, $data);
} catch (Throwable $e) {
    error_log('Påmelding backup – uventet feil: ' . $e->getMessage() . ' i ' . $e->getFile() . ':' . $e->getLine());
    svar(503, ['kode' => 'intern_feil', 'feil' => 'Noe gikk galt hos oss. Prøv igjen om litt – påmeldingen din er ikke lagret.']);
}
