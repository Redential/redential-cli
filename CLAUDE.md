# Redential CLI — reglas del repo

Open-source CLI (`@redential/cli`, Apache-2.0) que produce "proof bundles" de
SOLO METADATA desde repos git locales. El código fuente del usuario JAMÁS sale
de su máquina. Este repo es público y recibe PRs de terceros: cada regla de
acá existe porque la confianza es el producto.

## Qué es / qué no es

- ES: un detector local. Lee `git log` retroactivamente, produce un bundle
  JSON validado contra `schema/bundle.v1.json`, y lo sube SOLO con
  confirmación explícita del usuario.
- NO ES: un daemon, un tracker en tiempo real, un uploader automático.
  PROHIBIDO implementar watch mode, telemetría, o cualquier subida sin
  `redential submit` explícito.

## Principios innegociables (ver docs/principles.md)

Cada principio tiene tests en `test/privacy/`. Un PR que rompa un test de
privacidad no se mergea, sin excepciones. Cualquier cambio a QUÉ datos salen
de la máquina requiere: (1) issue de discusión previo, (2) version bump del
schema, (3) entrada en docs/schema.md y CHANGELOG.md.

## Seguridad

- CERO secretos en este repo. El CLI no conoce API keys de nadie: solo
  `SITE_URL` (pública) y el token del usuario obtenido por device flow.
- Token del usuario: `~/.config/redential/credentials.json` con permisos
  0600. Nunca en el cwd del repo escaneado. `redential logout` lo borra.
- Nunca loguear el token ni el bundle completo en errores. Stack traces sin
  payload.
- Secret-scan del PAYLOAD antes de cualquier output/submit (obligatorio):
  patrones de AWS keys, tokens genéricos, private keys, .env values.
- CERO scripts postinstall en package.json. CERO dependencias nuevas sin
  justificación escrita en el PR (superficie de supply-chain). Stack
  permitido: commander, vitest. Todo lo demás se discute primero.
- `package.json` con `files: ["dist"]` explícito.
- Releases: solo desde GitHub Actions en tags, con `npm publish --provenance`.
  Workflows de release JAMÁS corren en `pull_request`.

## Convenciones

- TypeScript estricto. Node >= 20. ESM.
- Comentarios de código y docs públicas en INGLÉS (repo internacional).
- Tests con vitest. Los fixtures son repos git creados programáticamente en
  tmpdir (nunca fixtures comiteados con historia real).
- Cada feature: entrada en CHANGELOG.md (Keep a Changelog, semver estricto)
  + doc en docs/ que explique cómo funciona.
- Cambios al schema del bundle = major o minor bump según compatibilidad.
- El comando `scan` SIEMPRE imprime el JSON exacto antes de cualquier submit.
- Si el remote del repo es accesible públicamente, `scan` sugiere conectar
  la GitHub App en vez de escanear (guardrail anti-canibalización).

## Límites para agentes

- REGLA INVIOLABLE — cero red en scan: `scan` no hace NINGUNA llamada de
  red. La detección de skills es matching determinístico de diffs (leídos
  localmente con `git show`/`git diff`) contra `signatures/*.json` (base de
  firmas versionada en este repo: imports, config files, patrones de API
  por librería). Nada de LLMs ni inferencia remota, en ninguna variante.
- REGLA INVIOLABLE — vocabulario cerrado: el bundle solo admite skill slugs
  presentes en `taxonomy.json` (público, en este repo). Un slug fuera de la
  lista invalida el bundle. Slugs nuevos entran por PR a `taxonomy.json`,
  jamás hardcodeados en el CLI.
- Nunca crear archivos con secretos ni valores de ejemplo que parezcan
  reales (usar `xxx-EXAMPLE-xxx`).
- Nunca agregar telemetría, analytics, ni llamadas de red fuera de
  `login`/`submit`.
- El server-side (endpoints /api/cli/*, tabla proof_bundles) vive en el repo
  redence, NO acá. Este repo termina en el HTTP request.
- El repo redence puede estar montado como contexto de LECTURA. JAMÁS copiar
  a este repo (que es público) código, paths, URLs internas o convenciones
  que revelen arquitectura de redence.
- Patrón executor/advisor: antes de arrancar un hito, presentale el plan al
  subagent `advisor` y aplicá su respuesta. Si fallaste 2 veces el mismo
  problema, consultalo antes del tercer intento. No lo consultes para
  trabajo rutinario: es caro a propósito.
- Gate de cierre: un hito NO está terminado hasta que el subagent
  `reviewer` devuelva "VERDICT: APPROVED". Si devuelve CHANGES REQUIRED,
  implementá los cambios y volvé a someterlo. El commit va después de la
  aprobación, nunca antes.
