# Empacotamento — executáveis do RPA Ops Monitor

Gera um executável nativo (Windows `.exe` / binário macOS) que roda sem
precisar instalar Python na máquina de quem for usar o painel — só quem
gera o executável precisa de Python + [PyInstaller](https://pyinstaller.org/).

## Formato: pasta, não arquivo único

O build produz uma **pasta** (`dist/RPA_Ops_Monitor/`) com o executável
dentro, não um `.exe`/binário único auto-extraível. Escolha deliberada:

- Abre mais rápido (o modo "onefile" do PyInstaller se extrai numa pasta
  temporária a cada execução).
- Muito menos chance de antivírus/EDR corporativo barrar — o padrão
  "executável único que se auto-extrai" do PyInstaller é um comportamento
  conhecido de dropper de malware, e dispara falso-positivo com frequência
  em ambiente corporativo (justamente o ambiente onde esta ferramenta roda).

## Sem janela de terminal (`console=False`)

O executável abre só o painel no navegador, sem uma janela de terminal atrás
— mas isso não significa perda de diagnóstico: `server.py` redireciona
`stdout`/`stderr` (o banner de inicialização, cada requisição `/api/...`, e
qualquer traceback de erro não tratado) para `RPA_Ops_Monitor.log`, criado
ao lado do executável na primeira execução. Se o painel abrir vazio ou algo
parecer errado, esse arquivo é o primeiro lugar a olhar. Sem esse
redirecionamento, o Windows deixa `sys.stdout`/`sys.stderr` como `None`
nesse modo — o primeiro `print()` (o próprio banner) derrubaria o processo
inteiro.

## Como gerar

```bash
# macOS (gera dist/RPA_Ops_Monitor/RPA_Ops_Monitor)
./packaging/build_macos.sh

# Windows (gera dist\RPA_Ops_Monitor\RPA_Ops_Monitor.exe) — duplo clique
# no arquivo, ou rode pelo prompt de comando:
packaging\build_windows.bat
```

Rode o script de novo sempre que o código mudar — ele nunca apaga
`config/`/`logs/` que já existam dentro de `dist/RPA_Ops_Monitor/` (só copia
na primeira vez), então dados reais do usuário (Cadastro de RPAs editado,
logs adicionados) sobrevivem a uma atualização do executável.

**PyInstaller não faz cross-compile**: o script do macOS só gera o binário
do macOS, o `.bat` do Windows só gera o `.exe` do Windows. Para gerar os
dois sem ter as duas máquinas, use o workflow do GitHub Actions:
**Actions → "Build executáveis (Windows/macOS)" → Run workflow** — builda
nas duas plataformas usando os runners hospedados do próprio GitHub e
disponibiliza os dois pacotes prontos como artifact pra baixar.

## Arquitetura: por que `config/`/`logs/` ficam de fora do bundle

`RPA_Ops_Monitor.spec` embute só os arquivos **somente-leitura** (HTMLs,
`assets/`, `docs/documentacao.html`) — `config/` e `logs/` nunca entram no
bundle. Motivo: um executável empacotado pelo PyInstaller extrai seus dados
embutidos para uma pasta temporária (`sys._MEIPASS`) **recriada do zero a
cada execução** — se `config/rpa_metadata.json` estivesse ali dentro,
qualquer edição feita pelo Cadastro de RPAs seria perdida ao fechar o app.

Por isso `server.py` distingue dois caminhos-base (ver o comentário no topo
do arquivo, perto de `BUNDLE_DIR`):

| Constante | Aponta para | Contém |
|---|---|---|
| `BUNDLE_DIR` | `sys._MEIPASS` (empacotado) / pasta do script (dev) | HTMLs, `assets/` — só leitura |
| `ROOT` | pasta do executável real (empacotado) / pasta do script (dev) | `config/`, `logs/` — graváveis, persistem entre execuções |

Rodando como `python3 server.py` (sem empacotar), os dois caminhos são a
mesma pasta — nenhum comportamento muda para quem usa dessa forma.

Efeito colateral (não é bug): no executável empacotado, `server.py` e
`config/aa_config.json` deixam de ser baixáveis via `GET` direto — eles
não estão mais dentro de `BUNDLE_DIR` (que é o que o servidor expõe
estaticamente), então nem chegam a ser servidos.

## Assinatura de código (não incluída)

Nenhum dos dois executáveis é assinado (exige certificado pago — Apple
Developer ID / Microsoft Authenticode, que este projeto não tem):

- **macOS**: primeira abertura mostra "desenvolvedor não identificado" —
  clique com o botão direito no executável → Abrir, uma única vez.
- **Windows**: SmartScreen pode avisar "Windows protegeu seu PC" — "Mais
  informações" → "Executar assim mesmo".

Isso é esperado e não indica problema no build. Ver `SECURITY.md` para a
consideração de segurança correspondente (treinar usuários a "clicar em
executar mesmo assim" é, em geral, um vetor de engenharia social — vale a
pena ter esse aviso em mente ao distribuir o executável).

## O que NÃO entra no pacote

`assets/observability-data.js` e `assets/index-data.js` (o fallback estático
usado só quando um HTML é aberto direto via `file://`, sem servidor) ficam
de fora de propósito — o servidor empacotado nunca lê esses arquivos (gera
os dados na hora, a partir dos logs reais), e o primeiro sozinho pesa
~15 MB. Se precisar do fallback `file://` a partir da pasta do executável,
copie os dois manualmente de dentro do repositório.
