<h1 align="center">Redential CLI</h1>

<div align="center">

[English](../../README.md) · [Español](README.es.md) · **Português (BR)** · [Français](README.fr.md) · [Italiano](README.it.md)

<p><img src="../assets/icon-pixel.svg" alt="Redential logo" height="88"></p>

<p><picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/wordmark-dark.svg">
<img src="../assets/wordmark-light.svg" alt="REDENTIAL" height="44">
</picture></p>

<p><picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/tagline-dark.svg">
<img src="../assets/tagline-light.svg" alt="private work into evidence." height="16">
</picture></p>

[![npm version](https://img.shields.io/npm/v/%40redential%2Fcli.svg)](https://www.npmjs.com/package/@redential/cli)
[![CI](https://github.com/Redential/redential-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Redential/redential-cli/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](../../LICENSE)

Seu melhor trabalho provavelmente está sob um NDA.

Transforme trabalho privado em uma credencial de desenvolvedor NDA-safe. Seu
código nunca sai da sua máquina.

<img src="../assets/demo.gif" alt="npx redential scan sendo executado em um terminal: capacidades detectadas localmente, nada é enviado" width="100%">

[Site](https://redential.com) · [Modelo de confiança](#modelo-de-confiança) · [FAQ](#faq) · [Documentação](#documentação)

</div>

## Como funciona

```bash
npx redential scan
```

Sem login, sem configuração, sem instalação global. O `scan` roda
inteiramente local e não faz nenhuma chamada de rede.

O Redential CLI analisa o histórico do git e os padrões de implementação
localmente, e então produz um bundle (pacote de evidências) limitado de
metadados, descrevendo as habilidades e capacidades detectadas em
repositórios que você não pode conectar.

Você revisa o bundle exato antes de qualquer coisa ser enviada. Se você
optar por rodar `submit`, a Redential adiciona essa evidência a um
[**perfil de capacidades Attested (atestado)**](#o-que-attested-realmente-comprova)
que você pode compartilhar.

Seu código-fonte nunca sai da sua máquina.

<!-- TODO: Add screenshot of a public profile showing Attested private-work capabilities -->

## Execute-o

Quando você quiser o resultado no seu perfil Redential:

```bash
npx redential login    # device flow, one time
npx redential submit   # scans again, shows you the bundle, asks before uploading
npx redential logout   # deletes the locally stored session
```

Prefira uma instalação persistente:

```bash
npm install -g redential
redential scan
```

(`redential` é um alias de
[`@redential/cli`](https://www.npmjs.com/package/@redential/cli), o pacote
canônico: veja [Verificando o pacote em si](#verificando-o-pacote-em-si).)

Plataformas suportadas: macOS, Linux e Windows, no Node.js 20 e 22 (cada
release é verificado nas seis combinações pela CI).

## O que o `scan` mostra

Em um terminal real, o `scan` imprime um resumo curto e legível para
humanos, não o JSON bruto. Ele é montado inteiramente a partir de campos
que já existem no bundle (veja [../schema.md](../schema.md) para todos os
campos, e [../scan.md](../scan.md) para o layout completo): capacidades
detectadas (achados estruturais, como um fluxo de tratamento de webhook
verificado, destacados primeiro; todo o restante agrupado por categoria),
principais linguagens e categorias, proporções de ownership (propriedade)
e de commits assinados, e um bloco final reafirmando o que sai da máquina
e o que nunca sai:

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

O JSON exato está a uma flag de distância, nunca escondido: `redential
scan --json` (ou `redential scan | jq`, ou qualquer stdout
redirecionado/encadeado) imprime **apenas** o bundle literal, byte a byte
o que `submit` enviaria. E `redential submit` sempre mostra a você esse
mesmo JSON exato, na íntegra, imediatamente antes de pedir a confirmação
do envio, em todos os caminhos, de forma impossível de pular. O resumo
acima é uma conveniência exclusiva do terminal, derivada desse mesmo
bundle, nunca uma segunda fonte de dados.

Este é o formato do payload (`redential scan --json`): o que de fato é
revisado antes de qualquer envio:

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

Referência completa de comandos: [../scan.md](../scan.md).

## Modelo de confiança

| Nunca sai da sua máquina | Só viaja depois que você roda `submit`, e só isso |
|---|---|
| Código-fonte, diffs, trechos de código | O bundle que o `scan` imprime com `--json` (e que o `submit` sempre mostra na íntegra antes do envio), byte a byte |
| Nomes de arquivos e diretórios | Uma extensão (`.ts`) e uma categoria inferida (`backend`) |
| Mensagens de commit | Cadência agregada: histogramas por hora/dia da semana |
| Nomes ou e-mails de outros contribuidores | Uma contagem agregada de outros contribuidores |
| A URL do remote | Apenas o *tipo* de host (`github`, `gitlab`, …), nunca a URL |
| Segredos de qualquer tipo | Nada: um secret-scan roda sobre o bundle e bloqueia a saída em caso de qualquer correspondência |
| - | Seu private label (rótulo privado): texto livre que *você mesmo* digita (nunca derivado do seu código), enviado ao lado do bundle, nunca dentro dele, exibido antes de você confirmar o envio, obrigatório, visível apenas para o dono ([../private-label.md](../private-label.md)) |

Cada linha à esquerda é respaldada por um [teste executável](../../test/privacy/),
conforme [../privacy-tests.md](../privacy-tests.md), não apenas uma
declaração de política. O próprio `scan` não faz nenhuma chamada de rede;
`login` e `submit` são os únicos dois comandos que tocam a rede, e
`submit` não envia nada sem sua confirmação explícita. Justificativa
completa: [../principles.md](../principles.md).

### Verificando o pacote em si

Todo release é publicado a partir do GitHub Actions em um commit com tag,
com proveniência do npm (`npm publish --provenance`), nunca a partir do
laptop de alguém. Verifique se qualquer versão instalada foi construída a
partir exatamente deste código-fonte:

```bash
npm audit signatures
```

Veja [../releasing.md](../releasing.md) para o processo completo de
release e o que a atestação de proveniência realmente comprova.

## FAQ

### Como alguém sabe que eu realmente fiz esse trabalho?
O CLI não afirma saber disso: esse é o ponto central do sistema de níveis
(tiers). Um bundle Attested diz: *o histórico de git desta máquina mostra
esta atividade, reivindicada por esta identidade.* Âncoras parciais
respaldam essa reivindicação (seus e-mails de commit são verificados
contra os e-mails da sua conta verificada, commits assinados não podem
ser forjados retroativamente sem sua chave, e a cadência da sua atividade
é verificada quanto à consistência no servidor), mas nada disso comprova
autoria, e este README nunca finge que comprova.

A resposta real está no que vem depois: qualquer pessoa pode *reivindicar*
um histórico, mas na Redential uma reivindicação pode ser desafiada: uma
defesa ao vivo, na qual você responde perguntas geradas a partir dos
próprios números do seu bundle, em tempo real. Quem realmente fez o
trabalho responde de memória. Quem copiou um histórico não tem nada para
lembrar. Se você não poderia ter feito o trabalho, você não consegue
defendê-lo, e uma reivindicação não defendida permanece visivelmente
estacionada no nível mais fraco, rotulada exatamente como o que é.

### Não posso simplesmente importar um monte de bibliotecas para inflar minha lista de habilidades?
Não: um import isolado dificilmente marca uma habilidade. A maioria das
assinaturas exige um especificador de import distintivo e inequívoco (não
um nome de pacote genérico compartilhado entre ecossistemas) ou um
formato real de chamada de API a partir dos seus próprios diffs
(`stripe.checkout`, não apenas `import Stripe`). Veja
[../signatures.md](../signatures.md) para as regras exatas de detecção e
a disciplina por trás delas. Mas a resposta honesta é maior do que a
precisão da detecção: este CLI só produz o nível **Attested**, o mais
fraco na Redential, explicitamente rotulado como metadados não
verificados. Inflar sua lista de habilidades te dá uma lista um pouco
mais longa no nível mais fraco; isso não faz nada pelos níveis Proven ou
Verified, que exigem código ao vivo ou uma sessão defendida. Manipular
metadados para parecer impressionante em um nível já rotulado como "leve
isso com uma pitada de sal" não é um grande prêmio.

### Não posso reproduzir o histórico de git de outra pessoa em um novo repositório e reivindicá-lo?
Você poderia fabricar timestamps de commit em um repositório novo: é
exatamente por isso que dados locais são explicitamente o nível *mais
fraco*, não o mais forte. Um histórico reproduzido ainda precisa
sobreviver a várias âncoras parciais: commits assinados (uma assinatura
GPG/SSH não pode ser forjada retroativamente sem a chave), uma impressão
digital comportamental (a cadência por hora/dia da semana é comparada com
sua própria atividade pública verificada, como uma checagem leve de
consistência), um sinal de forense de reescrita (`integrity.date_forensics`:
a data de autor do git é fácil de forjar, mas um script que reproduz anos
de histórico fabricado de uma só vez também deixa a data de *committer*
de cada commit concentrada nessa mesma sessão; um sinal heurístico do
lado do servidor, não um veredito local, veja
[../schema.md](../schema.md#date_forensics-measurement-contract)), e,
acima de tudo, o bundle só chega a ganhar o nível **Attested**, apenas
metadados. Qualquer coisa acima disso exige uma defesa NDA-safe: uma
breve sessão gravada em que você responde, ao vivo, perguntas geradas a
partir do seu próprio bundle. Falsificar um histórico de git é barato;
defender uma experiência fabricada sob interrogatório, em tempo real, não
é. Essa diferença é o verdadeiro limite de segurança, não as heurísticas
de detecção.

### O que exatamente sai da minha máquina?
O bundle: byte a byte o JSON que `redential scan --json` imprime e que
`submit` sempre mostra na íntegra antes de pedir sua confirmação, nada é
adicionado ou enriquecido depois disso. Essa não é uma promessa que você
precise aceitar por fé:
[`test/privacy/submit-guardrail.test.ts`](../../test/privacy/submit-guardrail.test.ts)
verifica que a string literal enviada por HTTP pelo `submit` é `===` à
string que ele imprimiu antes da sua confirmação, não uma re-serialização
de um objeto já processado. Cada campo é documentado em
[../schema.md](../schema.md), e o próprio schema (`schema/bundle.v1.json`)
define `additionalProperties: false` em todos os lugares: um campo não
listado torna o bundle inválido por construção, não apenas por convenção.

### Por que eu deveria confiar em um CLI com o código do meu empregador?
Porque ele nunca toca no código do seu empregador de nenhuma forma que
saia do seu laptop. Ele é local por design (`scan` é estruturalmente
livre de rede, não apenas livre de rede por padrão), totalmente open
source sob a licença Apache-2.0, para que você possa ler cada linha antes
de executá-lo, e suas afirmações de privacidade são
[testes executáveis](../../test/privacy/) que você mesmo pode rodar
(`npm test`), em vez de uma página de texto. Não há telemetria, não há
analytics, não há processo em segundo plano: as únicas duas chamadas de
rede que este CLI faz são o device flow do `login` e o envio do `submit`,
ambas exigindo uma ação explícita sua. E todo release publicado carrega
uma atestação de proveniência assinada pelo Sigstore, que você pode
verificar (`npm audit signatures`), provando que foi construído a partir
exatamente deste repositório, não do laptop de alguém.

### O que "Attested" realmente comprova?
Honestamente, não muita coisa sozinho, e isso é por design, não um
descuido. "Attested" significa: o histórico local de git desta pessoa
mostra este padrão de atividade, autodeclarado e refutável, com âncoras
parciais (commits assinados, impressão digital comportamental, checagens
de consistência no servidor), mas sem verificação independente do código
subjacente. Ele nunca é rotulado ou misturado visualmente com Proven ou
Verified, que exigem conectar um repositório legível (via GitHub App) ou
defender a reivindicação ao vivo. Pense em Attested como "merece uma
pergunta de acompanhamento", não como "verificado": todo o design do CLI
existe para manter essa distinção honesta, em vez de deixar um bundle de
metadados emprestar credibilidade que não conquistou. Veja
[../principles.md](../principles.md) (princípio 6, "Honesto sobre
confiança") para o raciocínio completo.

### Isso é apenas um funil para o seu SaaS?
A resposta honesta: o CLI é a camada de captura open source da
[Redential](https://redential.com), e a Redential é um produto comercial.
Nenhum desses fatos está escondido: você está lendo os dois agora mesmo.

O que torna isso uma ferramenta, e não um funil: o `scan` é totalmente
útil de forma independente. Sem conta, sem login, sem rede: ele analisa
seu repositório e mostra tudo o que encontrou, localmente, para sempre,
de graça. A plataforma só entra em cena se você decidir que o resultado
vale a pena publicar, e nada é enviado até que você tenha visto o payload
exato e confirmado o prompt. Não existe modo limitado, não existe
"desbloquear resultados completos": a análise local É a análise completa.

O modelo de negócio é a plataforma de credenciais. O papel do CLI é ser
confiável o suficiente para que você considere usá-lo, e é por isso que
toda afirmação de privacidade neste README corresponde a um teste
executável, em vez de uma promessa.

## Documentação

- [../principles.md](../principles.md): as seis regras inegociáveis
- [../privacy-tests.md](../privacy-tests.md): qual teste comprova qual regra
- [../scan.md](../scan.md): referência completa do comando `scan`
- [../login-submit.md](../login-submit.md): `login`, `submit`, `logout`
- [../private-label.md](../private-label.md): o private label obrigatório: o que é, por que ele viaja fora do bundle
- [../schema.md](../schema.md): todos os campos do bundle, explicados
- [../signatures.md](../signatures.md): como funciona a detecção de habilidades
- [../releasing.md](../releasing.md): como um release é construído e verificado

Se o repositório que você está escaneando é seu e pode ser conectado, o
`scan` não é a melhor ferramenta: o [GitHub App](https://redential.com)
lê o código de fato e concede níveis mais fortes do que metadados locais
jamais poderiam.

## Contribuindo

Veja [../../CONTRIBUTING.md](../../CONTRIBUTING.md): a maioria das
contribuições é uma adição de uma linha a um mapa de assinaturas, e
issues iniciais estão rotuladas como
[`up-for-grabs`](https://github.com/Redential/redential-cli/labels/up-for-grabs).
A contribuição que mais queremos: **ajudar a fortalecer a evidência**,
fazendo red-team dos sinais, propondo padrões estruturais mais fortes,
melhorando a forense de fraudes, sempre dentro da premissa NDA-safe (a
evidência só sai da máquina como metadados limitados). Relatos de bugs e
problemas de segurança: [../../SECURITY.md](../../SECURITY.md).

## Licença

Apache-2.0

---

O README em inglês é a versão canônica: se houver qualquer divergência,
a versão em inglês prevalece. Veja [../../README.md](../../README.md).
