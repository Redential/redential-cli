[English](../../README.md) · **Español** · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Italiano](README.it.md)

# Redential CLI

<img src="../assets/bannercli.png" alt="Redential CLI: convierte trabajo privado en una credencial de desarrollador NDA-safe" width="100%">

[![npm version](https://img.shields.io/npm/v/%40redential%2Fcli.svg)](https://www.npmjs.com/package/@redential/cli)
[![CI](https://github.com/Redential/redential-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Redential/redential-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](../../LICENSE)

Es probable que tu mejor trabajo esté bajo un NDA.

Convierte el trabajo privado en una credencial de desarrollador NDA-safe. Tu
código nunca sale de tu máquina.

```bash
npx redential scan
```

Sin login, sin configuración, sin instalación global. `scan` se ejecuta
completamente en local y no hace ninguna llamada de red.

<img src="../assets/demo.gif" alt="npx redential scan ejecutándose en una terminal: capacidades detectadas localmente, nada se sube" width="100%">

[Sitio web](https://redential.com) · [Modelo de confianza](#modelo-de-confianza) · [Preguntas frecuentes](#preguntas-frecuentes) · [Documentación](#documentación)

## Cómo funciona

Redential CLI analiza el historial de git y los patrones de implementación
de forma local, y luego produce un bundle (paquete de evidencia) acotado de
metadatos que describe las habilidades y capacidades detectadas en
repositorios que no puedes conectar.

Revisas el bundle exacto antes de que se suba nada. Si decides ejecutar
`submit`, Redential agrega esa evidencia a un
[**perfil de capacidades Attested (atestiguado)**](#qué-prueba-realmente-attested)
que puedes compartir.

Tu código fuente nunca sale de tu máquina.

<!-- TODO: Add screenshot of a public profile showing Attested private-work capabilities -->

## Ejecutarlo

Cuando quieras que el resultado aparezca en tu perfil de Redential:

```bash
npx redential login    # device flow, one time
npx redential submit   # scans again, shows you the bundle, asks before uploading
npx redential logout   # deletes the locally stored session
```

Si prefieres una instalación persistente:

```bash
npm install -g redential
redential scan
```

(`redential` es un alias de
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli), el paquete
canónico: consulta [Verificación del paquete en sí](#verificación-del-paquete-en-sí).)

Plataformas compatibles: macOS, Linux y Windows, en Node.js 20 y 22: cada
release se verifica contra las seis combinaciones mediante CI.

## Cómo se ve `scan`

En una terminal real, `scan` imprime un resumen breve y legible para
humanos, no el JSON crudo. Se arma enteramente a partir de campos que ya
están en el bundle (consulta [docs/schema.md](../schema.md) para ver cada
campo, y [docs/scan.md](../scan.md) para el diseño completo): las
capacidades detectadas (los hallazgos estructurales, como un flujo de
manejo de webhooks verificado, se muestran primero; todo lo demás se
agrupa por categoría), los principales lenguajes y categorías, los ratios
de propiedad (ownership) y de commits firmados, y un bloque final que
reafirma qué sale de la máquina y qué nunca sale:

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

El JSON exacto está a solo una opción de distancia, nunca se oculta:
`redential scan --json` (o `redential scan | jq`, o cualquier stdout
redirigido o con pipe) imprime **únicamente** el bundle literal, byte por
byte, lo mismo que enviaría `submit`. Y `redential submit` siempre te
muestra ese mismo JSON exacto, completo, justo antes de pedirte que
confirmes la subida, en todos los casos, sin posibilidad de omitirlo. El
resumen de arriba es una comodidad exclusiva de la terminal derivada de
ese mismo bundle, nunca una segunda fuente de datos.

Esta es la forma del payload (`redential scan --json`): lo que
efectivamente se revisa antes de cualquier subida:

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

Referencia completa de comandos: [docs/scan.md](../scan.md).

## Modelo de confianza

| Nunca sale de tu máquina | Solo viaja después de que ejecutas `submit`, y solo esto |
|---|---|
| Código fuente, diffs, fragmentos | El bundle que `scan` imprime con `--json` (y que `submit` siempre muestra completo antes de subir), byte por byte |
| Nombres de archivos y directorios | Una extensión (`.ts`) y una categoría inferida (`backend`) |
| Mensajes de commit | Cadencia agregada: histogramas por hora y día de la semana |
| Nombres o correos de otros colaboradores | Un conteo agregado de otros colaboradores |
| La URL del remoto | Solo el *tipo* de host (`github`, `gitlab`, …), nunca la URL |
| Secretos de cualquier tipo | Nada: se ejecuta un secret-scan (escaneo de secretos) sobre el bundle y se bloquea la salida ante cualquier coincidencia |
| – | Tu private label: texto libre que *tú mismo* escribes (nunca derivado de tu código), enviado junto al bundle, nunca dentro de él, mostrado antes de confirmar la subida, obligatorio, visible solo para el dueño ([docs/private-label.md](../private-label.md)) |

Cada fila de la izquierda está respaldada por una
[prueba ejecutable](../../test/privacy/), según
[docs/privacy-tests.md](../privacy-tests.md): no es solo una declaración
de política. `scan` en sí mismo no hace ninguna llamada de red; `login` y
`submit` son los únicos dos comandos que tocan la red, y `submit` no sube
nada sin tu confirmación explícita. Razonamiento completo:
[docs/principles.md](../principles.md).

### Verificación del paquete en sí

Cada release se publica desde GitHub Actions sobre un commit etiquetado
(tag) con proveniencia de npm (`npm publish --provenance`), nunca desde la
laptop de nadie. Verifica que cualquier versión instalada se haya
construido a partir de este código fuente exacto:

```bash
npm audit signatures
```

Consulta [docs/releasing.md](../releasing.md) para ver el proceso de
release completo y qué es lo que realmente demuestra la atestación de
proveniencia.

## Preguntas frecuentes

### ¿Cómo sabe alguien que yo realmente hice este trabajo?
El CLI no pretende saberlo: ese es precisamente el sentido del sistema de
niveles (tiers). Un bundle Attested dice: *el historial de git de esta
máquina muestra esta actividad, reclamada por esta identidad.* Anclas
parciales respaldan la afirmación (tus correos de commit se verifican
contra los correos verificados de tu cuenta, los commits firmados no se
pueden falsificar retroactivamente sin tu clave, y la cadencia de tu
actividad se verifica por consistencia en el servidor), pero nada de eso
prueba autoría, y el README nunca pretende que lo haga.

La respuesta real es lo que viene después: cualquiera puede *reclamar* un
historial, pero en Redential un reclamo puede ser desafiado: una defensa
en vivo, donde respondes preguntas generadas a partir de los propios
números de tu bundle, en tiempo real. Quien hizo el trabajo responde de
memoria. Quien copió un historial no tiene nada que recordar. Si no
pudiste haber hecho el trabajo, no puedes defenderlo, y un reclamo sin
defender queda visiblemente estacionado en el nivel más débil, etiquetado
exactamente como lo que es.

### ¿No puedo simplemente importar un montón de librerías para inflar mi lista de habilidades?
No: un simple import por sí solo rara vez etiqueta una habilidad. La
mayoría de las firmas (signatures) requieren un especificador de import
distintivo e inequívoco (no un nombre de paquete genérico compartido
entre ecosistemas) o una forma real de llamada a la API tomada de tus
propios diffs (`stripe.checkout`, no solo `import Stripe`). Consulta
[docs/signatures.md](../signatures.md) para conocer las reglas exactas de
detección y la disciplina detrás de ellas. Pero la respuesta honesta va
más allá de la precisión de la detección: este CLI únicamente produce el
nivel **Attested**, el más débil en Redential, etiquetado explícitamente
como metadatos sin verificar. Inflar tu lista de habilidades te da una
lista apenas más larga en el nivel más débil; no aporta nada para Proven
o Verified, que requieren código en vivo o una sesión defendida. Manipular
metadatos para parecer impresionante en un nivel que ya está etiquetado
como "tómalo con pinzas" no es gran premio.

### ¿No puedo reproducir el historial de git de otra persona en un repositorio nuevo y reclamarlo?
Podrías fabricar marcas de tiempo de commits en un repositorio nuevo: por
eso, precisamente, los datos locales son explícitamente el nivel *más
débil*, no el más fuerte. Un historial reproducido igual tiene que
sobrevivir a varias anclas parciales: commits firmados (una firma GPG/SSH
no se puede falsificar retroactivamente sin la clave), una huella de
comportamiento (la cadencia por hora y día de la semana se compara con tu
propia actividad pública verificada, como una verificación de
consistencia blanda), una señal de forense de reescritura
(`integrity.date_forensics`: la fecha de autor de git es fácil de
falsificar, pero un script que reproduce años de historial fabricado en
una sola sesión también deja la fecha de *committer* de cada commit
agrupada en esa misma sesión; una señal heurística del lado del servidor,
no un veredicto local; consulta
[docs/schema.md](../schema.md#date_forensics-measurement-contract)), y,
por encima de todo, el bundle solo puede alcanzar el nivel **Attested**,
solo metadatos. Cualquier cosa por encima de eso requiere una defensa
NDA-safe: una sesión breve y grabada donde respondes en vivo preguntas
generadas a partir de tu propio bundle. Fabricar un historial de git es
barato; defender experiencia fabricada bajo interrogatorio, en tiempo
real, no lo es. Esa brecha es el verdadero límite de seguridad, no las
heurísticas de detección.

### ¿Qué sale exactamente de mi máquina?
El bundle: byte por byte, el JSON que imprime `redential scan --json` y
que `submit` siempre muestra completo antes de pedir tu confirmación, sin
nada agregado ni enriquecido después. Esa no es una promesa que tengas
que creer por fe:
[`test/privacy/submit-guardrail.test.ts`](../../test/privacy/submit-guardrail.test.ts)
verifica que el string literal enviado por HTTP por `submit` sea `===`
(idéntico) al string que se imprimió antes de tu confirmación, no una
reserialización de un objeto ya parseado. Cada campo está documentado en
[docs/schema.md](../schema.md), y el propio schema
(`schema/bundle.v1.json`) establece `additionalProperties: false` en
todas partes: un campo no listado invalida el bundle por construcción, no
solo por convención.

### ¿Por qué debería confiarle a un CLI el código de mi empleador?
Porque nunca toca el código de tu empleador de ninguna forma que salga de
tu laptop. Es exclusivamente local (`scan` no tiene red de forma
estructural, no simplemente sin red por defecto), es completamente open
source bajo Apache-2.0 para que puedas leer cada línea antes de
ejecutarlo, y sus afirmaciones de privacidad son
[pruebas ejecutables](../../test/privacy/) que tú mismo corres
(`npm test`), en lugar de una página de texto. No hay telemetría, no hay
analítica, no hay proceso en segundo plano: las únicas dos llamadas de
red que este CLI hace jamás son el device flow de `login` y la subida de
`submit`, y ambas requieren una acción explícita tuya. Y cada release
publicado lleva una atestación de proveniencia firmada con Sigstore que
puedes verificar (`npm audit signatures`), lo que demuestra que se
construyó a partir de este repositorio exacto, no desde la laptop de
alguien.

### ¿Qué prueba realmente "Attested"?
Honestamente, no mucho por sí solo, y eso es por diseño, no un descuido.
"Attested" significa: el historial de git local de esta persona muestra
este patrón de actividad, autodeclarado y falseable, con anclas parciales
(commits firmados, huella de comportamiento, verificaciones de
consistencia del lado del servidor) pero sin verificación independiente
del código subyacente. Nunca se etiqueta ni se mezcla visualmente con
Proven o Verified, que requieren conectar un repositorio legible (vía la
GitHub App) o defender el reclamo en vivo. Piensa en Attested como
"merece una pregunta de seguimiento", no como "verificado": todo el
diseño del CLI existe para mantener esa distinción honesta, en lugar de
dejar que un bundle de metadatos tome prestada una credibilidad que no se
ha ganado. Consulta [docs/principles.md](../principles.md) (principio 6,
"Honesto sobre la confianza") para el razonamiento completo.

### ¿Esto es solo un embudo para su SaaS?
La respuesta honesta: el CLI es la capa de captura open source de
[Redential](https://redential.com), y Redential es un producto comercial.
Ninguno de esos hechos está oculto: los estás leyendo justo ahora.

Lo que lo convierte en una herramienta y no en un embudo: `scan` es
completamente útil de forma independiente (standalone). Sin cuenta, sin
login, sin red: analiza tu repositorio y te muestra todo lo que
encontró, localmente, para siempre, gratis. La plataforma solo entra en
juego si decides que el resultado vale la pena publicar, y nada se sube
hasta que hayas visto el payload exacto y confirmado el prompt. No hay un
modo limitado, ni un "desbloquea los resultados completos": el análisis
local ES el análisis completo.

El modelo de negocio es la plataforma de credenciales. El trabajo del CLI
es ser lo suficientemente confiable como para que consideres usarlo, y
por eso cada afirmación de privacidad en este README corresponde a una
prueba ejecutable en lugar de a una promesa.

## Documentación

- [docs/principles.md](../principles.md): las seis reglas innegociables
- [docs/privacy-tests.md](../privacy-tests.md): qué prueba demuestra qué regla
- [docs/scan.md](../scan.md): referencia completa del comando `scan`
- [docs/login-submit.md](../login-submit.md): `login`, `submit`, `logout`
- [docs/private-label.md](../private-label.md): el private label obligatorio: qué es, por qué viaja fuera del bundle
- [docs/schema.md](../schema.md): cada campo del bundle, explicado
- [docs/signatures.md](../signatures.md): cómo funciona la detección de habilidades
- [docs/releasing.md](../releasing.md): cómo se construye y verifica un release

Si el repositorio que estás escaneando es tuyo y es conectable, `scan` no
es la mejor herramienta: la [GitHub App](https://redential.com) lee el
código real y otorga niveles más fuertes de los que los metadatos locales
jamás podrían dar.

## Contribuir

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md): la mayoría de las
contribuciones son una línea agregada a un mapa de firmas (signature
map), y los issues para empezar están etiquetados como
[`up-for-grabs`](https://github.com/Redential/redential-cli/labels/up-for-grabs).
La contribución que más queremos: **ayudar a fortalecer la evidencia**,
hacer red-team de las señales, proponer patrones estructurales más
fuertes, mejorar el forense de falsificación, siempre dentro de la
premisa NDA-safe (la evidencia sale de la máquina solo como metadatos
acotados). Reportes de bugs y problemas de seguridad:
[SECURITY.md](../../SECURITY.md).

## Licencia

Apache-2.0

---

**Nota:** el README en inglés es la versión canónica de este documento.
Si algo difiere entre esta traducción y la versión en inglés, la versión
en inglés prevalece. Consulta [../../README.md](../../README.md).
