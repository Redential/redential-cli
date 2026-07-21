<div align="center">

[English](../../README.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · **Italiano**

<img src="../assets/bannercli.png" alt="Redential CLI: trasforma il lavoro privato in una credenziale per sviluppatori NDA-safe" width="100%">

# Redential CLI

[![npm version](https://img.shields.io/npm/v/%40redential%2Fcli.svg)](https://www.npmjs.com/package/@redential/cli)
[![CI](https://github.com/Redential/redential-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Redential/redential-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](../../LICENSE)

Il tuo lavoro migliore è probabilmente coperto da un NDA.

Trasforma il lavoro privato in una credenziale per sviluppatori NDA-safe. Il
tuo codice non lascia mai la tua macchina.

<img src="../assets/demo.gif" alt="npx redential scan in esecuzione in un terminale: capacità rilevate in locale, nessun caricamento" width="100%">

[Sito web](https://redential.com) · [Modello di fiducia](#modello-di-fiducia) · [FAQ](#faq) · [Documentazione](#documentazione)

</div>

## Come funziona

```bash
npx redential scan
```

Nessun login, nessuna configurazione, nessuna installazione globale. `scan`
viene eseguito interamente in locale e non effettua alcuna chiamata di rete.

Redential CLI analizza la cronologia git e i pattern di implementazione in
locale, quindi produce un bundle (pacchetto di metadati) limitato che
descrive le competenze e le capacità rilevate nei repository che non puoi
connettere.

Esamini il bundle esatto prima che venga caricato qualsiasi cosa. Se scegli
di inviarlo (submit), Redential aggiunge quella prova a un [**profilo di
capacità Attested (attestato)**](#cosa-dimostra-realmente-attested) che puoi
condividere.

Il tuo codice sorgente non lascia mai la tua macchina.

<!-- TODO: Add screenshot of a public profile showing Attested private-work capabilities -->

## Eseguilo

Quando vuoi il risultato sul tuo profilo Redential:

```bash
npx redential login    # device flow, one time
npx redential submit   # scans again, shows you the bundle, asks before uploading
npx redential logout   # deletes the locally stored session
```

Preferisci un'installazione persistente:

```bash
npm install -g redential
redential scan
```

(`redential` è un alias di
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli), il
pacchetto canonico: vedi [Verificare il pacchetto stesso](#verificare-il-pacchetto-stesso).)

Piattaforme supportate: macOS, Linux e Windows, su Node.js 20 e 22: ogni
release viene verificata su tutte e sei le combinazioni dalla CI.

## Cosa mostra `scan`

Su un terminale reale, `scan` stampa un breve riepilogo leggibile da un
essere umano, non il JSON grezzo. È costruito interamente a partire da campi
già presenti nel bundle (vedi [../schema.md](../schema.md) per ogni campo, e
[../scan.md](../scan.md) per il layout completo): le capacità rilevate (i
risultati strutturali, come un flusso di gestione webhook verificato,
vengono mostrati per primi; tutto il resto è raggruppato per categoria), i
principali linguaggi e categorie, i rapporti di ownership e di commit
firmati, e un blocco finale che ribadisce cosa lascia la macchina e cosa non
lo fa mai:

```
  PRIVATE WORK, LOCALLY DERIVED
  1 year · 1,378 authored commits · 78% ownership

  CAPABILITIES DETECTED

  Payment webhook flow     4 commits   STRUCTURAL · DIRECT

  Payments
    Stripe                12 commits

  TOP LANGUAGES
  .ts   ████████████████████   62%
  .sql  █████░░░░░░░░░░░░░░░   14%

  TOP CATEGORIES
  Backend  ████████████████████   51%
  Testing  ███████░░░░░░░░░░░░░   18%

  Ownership       78% of this repo's commits are yours
  Signed commits  45% of your commits are cryptographically signed

  ────────────────────────────────────────────────────────────
  Nothing left your machine. Nothing is uploaded unless you run
  `redential submit` — and only the bounded bundle: aggregates,
  salted fingerprints, and closed-vocabulary capability slugs.
  Never code, file names, commit messages, or other contributors.
  Verify: github.com/Redential/redential-cli
  ────────────────────────────────────────────────────────────

  Inspect the exact payload:  redential scan --json
  More detail (hour/weekday histograms):  redential scan --details

  Add this private work to your public Redential profile:
  → redential login && redential submit
```

Il JSON esatto è a un flag di distanza, mai nascosto: `redential scan --json`
(oppure `redential scan | jq`, o qualsiasi stdout reindirizzato/in pipe)
stampa **solo** il bundle letterale, byte per byte quello che `submit`
invierebbe: e `redential submit` mostra sempre quello stesso identico JSON
per intero, immediatamente prima di chiederti di confermare il caricamento,
su ogni percorso, in modo non saltabile. Il riepilogo sopra è una comodità
valida solo per il terminale, derivata da quello stesso bundle, mai una
seconda fonte di dati.

Questa è la forma del payload (`redential scan --json`): ciò che viene
effettivamente esaminato prima di qualsiasi caricamento:

```
{
  "schema_version": "1.2.0",
  "runner": "local",
  "tool_version": "0.5.0",
  "created_at": "2026-07-09T14:32:01.000Z",
  "repo": { "host_type": "github", "age_days": 742, "repo_fingerprint": "a3f9…" },
  "identity": { "author_identity_hashes": ["9c1e…"], "other_contributors_count": 3 },
  "commits": { "user_total": 1847, "first_at": "2024-06-02T09:14:00Z", "last_at": "2026-07-08T21:05:00Z", "span_days": 767, "hour_histogram": [...], "weekday_histogram": [...] },
  "signed": { "count": 831, "ratio": 0.45, "key_types": ["ssh"] },
  "languages": [ { "extension": ".ts", "share": 0.62 }, { "extension": ".sql", "share": 0.14 } ],
  "categories": [ { "name": "backend", "commit_count": 902, "churn_share": 0.51 }, { "name": "testing", "commit_count": 340, "churn_share": 0.18 } ],
  "detected_skills": [ { "slug": "payments/stripe", "commit_count": 12, "first_seen": "2024-09-01T10:00:00Z", "last_seen": "2025-11-20T18:30:00Z" }, { "slug": "payments/payment-webhook-flow", "commit_count": 4, "first_seen": "2024-09-03T08:00:00Z", "last_seen": "2024-09-03T08:00:00Z", "evidence": "structural", "confidence": "direct" } ],
  "ownership": { "user_commit_ratio": 0.78 },
  "integrity": { "merkle_root": "7be2…", "algorithm": "sha256", "date_forensics": { "author_span_days": 767, "committer_span_days": 763, "mismatch_ratio": 0.06, "committer_burst_ratio": 0.02 } },
  "attestation": { "authorized_confirmation": true, "confirmed_at": "2026-07-09T14:32:01.000Z" }
}
```

Riferimento completo dei comandi: [../scan.md](../scan.md).

## Modello di fiducia

| Non lascia mai la tua macchina | Viaggia solo dopo aver eseguito `submit`, e solo questo |
|---|---|
| Codice sorgente, diff, snippet | Il bundle che `scan` stampa con `--json` (e che `submit` mostra sempre per intero prima del caricamento): byte per byte |
| Nomi di file e directory | Un'estensione (`.ts`) e una categoria dedotta (`backend`) |
| Messaggi di commit | Cadenza aggregata: istogrammi orari/per giorno della settimana |
| Nomi o email degli altri collaboratori | Un conteggio aggregato degli altri collaboratori |
| L'URL del remote | Solo il *tipo* di host (`github`, `gitlab`, …), mai l'URL |
| Segreti di qualsiasi tipo | Niente: viene eseguita una scansione dei segreti (secret-scan) sul bundle che blocca l'output in caso di corrispondenza |
| — | La tua private label: testo libero che *tu* digiti personalmente (mai derivato dal tuo codice), inviato insieme al bundle, mai al suo interno, mostrato prima di confermare il caricamento, obbligatorio, visibile solo al proprietario ([../private-label.md](../private-label.md)) |

Ogni riga a sinistra è supportata da un [test eseguibile](../../test/privacy/),
secondo [../privacy-tests.md](../privacy-tests.md): non è solo una
dichiarazione di policy. `scan` di per sé non effettua alcuna chiamata di
rete; `login` e `submit` sono gli unici due comandi che toccano la rete, e
`submit` non carica nulla senza la tua conferma esplicita. Motivazione
completa: [../principles.md](../principles.md).

### Verificare il pacchetto stesso

Ogni release viene pubblicata da GitHub Actions su un commit taggato con
provenance npm (`npm publish --provenance`): mai dal laptop di qualcuno.
Verifica che qualsiasi versione installata sia stata compilata a partire da
questo identico codice sorgente:

```bash
npm audit signatures
```

Vedi [../releasing.md](../releasing.md) per il processo di release completo
e per cosa dimostra realmente l'attestazione di provenance.

## FAQ

### Come fa qualcuno a sapere che ho davvero fatto questo lavoro?
La CLI non pretende di saperlo: è proprio questo il punto del sistema a
livelli. Un bundle Attested dice: *la cronologia git di questa macchina
mostra questa attività, rivendicata da questa identità.* Ancoraggi parziali
sostengono l'affermazione (le tue email di commit vengono confrontate con le
email verificate del tuo account, i commit firmati non possono essere
falsificati retroattivamente senza la tua chiave, e la cadenza della tua
attività viene verificata per coerenza lato server), ma niente di tutto ciò
dimostra la paternità, e il README non pretende mai che lo faccia.

La vera risposta sta in quello che viene dopo: chiunque può *rivendicare*
una cronologia, ma su Redential una rivendicazione può essere messa alla
prova: una difesa dal vivo, in cui rispondi a domande generate a partire
dai numeri del tuo stesso bundle, in tempo reale. Chi ha svolto il lavoro
risponde a memoria. Chi ha copiato una cronologia non ha nulla da
ricordare. Se non avresti potuto svolgere il lavoro, non puoi difenderlo: e
una rivendicazione non difesa resta visibilmente ferma al livello più
debole, etichettata esattamente per quello che è.

### Non posso semplicemente importare un mucchio di librerie per gonfiare il mio elenco di competenze?
No: una semplice importazione da sola raramente etichetta una competenza. La
maggior parte delle signature richiede o uno specificatore di importazione
distintivo e non ambiguo (non un nome di pacchetto generico condiviso tra
più ecosistemi) o una forma effettiva di chiamata API tratta dai tuoi stessi
diff (`stripe.checkout`, non semplicemente `import Stripe`). Vedi
[../signatures.md](../signatures.md) per le regole di rilevamento esatte e
la disciplina che le sostiene. Ma la risposta onesta va oltre l'accuratezza
del rilevamento: questa CLI produce sempre e solo il livello **Attested**,
il più debole su Redential, esplicitamente etichettato come metadati non
verificati. Gonfiare il tuo elenco di competenze ti procura un elenco
leggermente più lungo sul livello più debole; non fa nulla per Proven o
Verified, che richiedono codice live o una sessione difesa. Manipolare i
metadati per apparire impressionanti su un livello già etichettato come "da
prendere con le pinze" non è un gran premio.

### Non posso semplicemente riprodurre la cronologia git di qualcun altro in un nuovo repository e rivendicarla?
Potresti falsificare i timestamp dei commit in un repository nuovo di
zecca: è esattamente per questo che i dati locali sono esplicitamente il
livello *più debole*, non il più forte. Una cronologia riprodotta deve
comunque superare diversi ancoraggi parziali: i commit firmati (una firma
GPG/SSH non può essere falsificata retroattivamente senza la chiave),
un'impronta comportamentale (la cadenza oraria/per giorno della settimana
viene confrontata con la tua attività pubblica verificata come controllo di
coerenza leggero), un segnale di forensics sulla riscrittura
(`integrity.date_forensics`: la data dell'autore in git è facile da
falsificare, ma uno script che riproduce anni di cronologia fabbricata in
un'unica sessione lascia anche la data del *committer* di ogni commit
raggruppata in quella stessa sessione; un segnale euristico lato server, non
un verdetto locale, vedi
[../schema.md#date_forensics-measurement-contract](../schema.md#date_forensics-measurement-contract)),
e, soprattutto, il bundle ottiene comunque e soltanto **Attested**, solo
metadati. Qualsiasi cosa al di sopra richiede una difesa NDA-safe: una
breve sessione registrata in cui rispondi dal vivo a domande generate a
partire dal tuo stesso bundle. Falsificare una cronologia git è economico;
difendere un'esperienza fabbricata sotto interrogatorio, in tempo reale,
non lo è. Questo è il vero confine di sicurezza, non le euristiche di
rilevamento.

### Cosa lascia esattamente la mia macchina?
Il bundle: byte per byte il JSON che `redential scan --json` stampa e che
`submit` mostra sempre per intero prima di chiederti conferma, senza nulla
aggiunto o arricchito in seguito. Non è una promessa che devi prendere per
fede:
[`../../test/privacy/submit-guardrail.test.ts`](../../test/privacy/submit-guardrail.test.ts)
verifica che la stringa letterale inviata via HTTP da `submit` sia `===`
alla stringa che ha stampato prima della tua conferma, non una
ri-serializzazione di un oggetto analizzato. Ogni campo è documentato in
[../schema.md](../schema.md), e lo schema stesso (`schema/bundle.v1.json`)
imposta `additionalProperties: false` ovunque: un campo non elencato rende
il bundle non valido per costruzione, non solo per convenzione.

### Perché dovrei fidarmi di una CLI con il codice del mio datore di lavoro?
Perché non tocca mai il codice del tuo datore di lavoro in alcuna forma che
lasci il tuo laptop. È solo locale (`scan` è strutturalmente privo di rete,
non semplicemente privo di rete per impostazione predefinita), completamente
open source sotto licenza Apache-2.0, così puoi leggere ogni riga prima di
eseguirlo, e le sue affermazioni sulla privacy sono [test
eseguibili](../../test/privacy/) che esegui tu stesso (`npm test`) invece di
una pagina di prosa. Non c'è telemetria, non ci sono analytics, nessun
processo in background: le uniche due chiamate di rete che questa CLI
effettua mai sono il device flow di `login` e il caricamento di `submit`,
entrambe richiedono un'azione esplicita da parte tua. E ogni release
pubblicata porta un'attestazione di provenance firmata con Sigstore che puoi
verificare (`npm audit signatures`), a dimostrazione che è stata compilata a
partire da questo identico repository, non dal laptop di qualcuno.

### Cosa dimostra realmente "Attested"?
Onestamente, non moltissimo da solo, ed è voluto, non una svista.
"Attested" significa: la cronologia git locale di questa persona mostra
questo schema di attività, autodichiarato e falsificabile, con ancoraggi
parziali (commit firmati, impronta comportamentale, controlli di coerenza
lato server) ma nessuna verifica indipendente del codice sottostante. Non
viene mai etichettato o mescolato visivamente con Proven o Verified, che
richiedono di collegare un repository leggibile (tramite la GitHub App) o
di difendere l'affermazione dal vivo. Pensa ad Attested come a "merita una
domanda di approfondimento", non come a "verificato": l'intero design della
CLI esiste per mantenere onesta questa distinzione, invece di lasciare che
un bundle di metadati prenda in prestito una credibilità che non si è
guadagnato. Vedi [../principles.md](../principles.md) (principio 6, "Honest
about trust") per il ragionamento completo.

### È solo un funnel per il vostro SaaS?
La risposta onesta: la CLI è lo strato di acquisizione open source per
[Redential](https://redential.com), e Redential è un prodotto commerciale.
Nessuno di questi due fatti è nascosto: li stai leggendo proprio ora.

Ciò che la rende uno strumento e non un funnel: `scan` è pienamente utile
da sola. Nessun account, nessun login, nessuna rete: analizza il tuo
repository e ti mostra tutto quello che ha trovato, in locale, per sempre,
gratis. La piattaforma entra in gioco solo se decidi che il risultato vale
la pena di essere pubblicato, e non viene caricato nulla finché non hai
visto il payload esatto e confermato la richiesta. Non esiste una modalità
limitata, nessuno "sblocca i risultati completi": l'analisi locale È
l'analisi completa.

Il modello di business è la piattaforma di credenziali. Il compito della
CLI è essere abbastanza affidabile da farti prendere in considerazione il
suo utilizzo: motivo per cui ogni affermazione sulla privacy in questo
README corrisponde a un test eseguibile invece che a una promessa.

## Documentazione

- [../principles.md](../principles.md): le sei regole non negoziabili
- [../privacy-tests.md](../privacy-tests.md): quale test dimostra quale regola
- [../scan.md](../scan.md): riferimento completo del comando `scan`
- [../login-submit.md](../login-submit.md): `login`, `submit`, `logout`
- [../private-label.md](../private-label.md): la private label obbligatoria: cos'è, perché viaggia al di fuori del bundle
- [../schema.md](../schema.md): ogni campo del bundle, spiegato
- [../signatures.md](../signatures.md): come funziona il rilevamento delle competenze
- [../releasing.md](../releasing.md): come viene costruita e verificata una release

Se il repository che stai scansionando è tuo e connettibile, `scan` non è
lo strumento migliore: la [GitHub App](https://redential.com) legge il
codice effettivo e concede livelli più forti di quanto i metadati locali
potranno mai fare.

## Come contribuire

Vedi [../../CONTRIBUTING.md](../../CONTRIBUTING.md): la maggior parte dei
contributi consiste in un'aggiunta di una riga a una mappa di signature, e
le issue per iniziare sono etichettate
[`up-for-grabs`](https://github.com/Redential/redential-cli/labels/up-for-grabs).
Il contributo che desideriamo di più: **aiutaci a rafforzare le prove**, fai
red-teaming sui segnali, proponi pattern strutturali più solidi, migliora
la forensics anti-contraffazione, sempre nel rispetto della premessa
NDA-safe (le prove lasciano la macchina solo come metadati limitati).
Segnalazioni di bug e problemi di sicurezza: [../../SECURITY.md](../../SECURITY.md).

## Licenza

Apache-2.0

---

Il README in inglese è la versione di riferimento (canonica): in caso di
differenze, prevale la versione inglese. Vedi [../../README.md](../../README.md).
