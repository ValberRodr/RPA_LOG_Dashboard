# Cache SQLite incremental — RPA Ops Monitor

## Objetivo

Evitar reler e reprocessar todo o compartilhamento de logs a cada abertura do
dashboard. Os arquivos de origem continuam sendo a fonte oficial; o SQLite é
um cache persistente reconstruível.

## Local padrão no Windows

`\\d7156ws1011\DirGeralAdmFin\Organizaçao&Processos\Melhoria_Continua\Monitoramento\rpa_ops_monitor.sqlite3`

O caminho pode ser sobrescrito por `RPA_MONITOR_DB_PATH`.

## Fluxo

1. Se o banco ainda não possui dados, a primeira abertura percorre todo o
   histórico, parseia os arquivos e grava os registros no SQLite.
2. A tela padrão consulta somente os últimos 30 dias do banco.
3. O usuário pode mudar para 90 dias, 120 dias ou todos os logs. Essa troca
   consulta somente o SQLite; não reabre os arquivos-fonte.
4. O botão **Atualizar** sincroniza arquivos novos ou alterados.
5. Cada arquivo mantém no manifesto: tamanho observado, último byte confirmado,
   quantidade de linhas físicas e uma assinatura leve do início+fim do trecho
   já processado.
6. Se o mesmo arquivo apenas cresceu, a leitura começa exatamente no último
   byte confirmado. As linhas antigas não são abertas, apagadas ou reinseridas.
7. Se o arquivo não mudou, nenhum conteúdo é lido.
8. Se diminuiu, foi sobrescrito, mudou mantendo o mesmo tamanho ou a assinatura
   do prefixo não confere, o arquivo é reindexado inteiro para impedir
   duplicidade/corrupção silenciosa.
9. Uma linha JSON ainda incompleta no fim do arquivo fica aguardando o próximo
   newline e só então entra no banco.
10. A descoberta incremental também revalida os arquivos mais recentes já
    conhecidos de cada RPA/VM, inclusive se estiverem fora da janela de busca
    recente, para suportar logs antigos que continuam recebendo append.

## Estrutura

- `source_files`: manifesto dos arquivos já processados, incluindo
  `processed_bytes`, `line_count` e `guard_hash`.
- `raw_records`: JSON de execução, etapa e telemetria normalizado para
  consulta por data/processo/execução/máquina.
- `store_meta`: versão do schema, revisão e data da última sincronização.

A revisão só aumenta quando dados mudam. O `DataCache` usa essa revisão +
o mtime/tamanho do Cadastro de RPAs como fingerprint para evitar reconstruir
o dataset sem necessidade.

## Compartilhamento de rede

O banco usa `journal_mode=DELETE`, `synchronous=FULL`, `busy_timeout` e
um lock externo `.sync.lock`. WAL não é usado em compartilhamento SMB.
Somente uma sincronização pode escrever por vez; outras instâncias aguardam.

## Resiliência do cadastro

Um `rpa_metadata.json` válido porém vazio (`{}`) não derruba mais o
dashboard. As chaves `rpas` e `schedules` ausentes são tratadas como listas
vazias. Processos encontrados nos logs e ainda não cadastrados aparecem
temporariamente como **NÃO CADASTRADA**, com dados técnicos inferidos dos
logs; nada é gravado automaticamente no cadastro.

JSON malformado continua sendo rejeitado com mensagem explícita para evitar
sobrescrever silenciosamente um arquivo potencialmente corrompido.

## Testes

```bash
python -m unittest -v test_server.py test_sqlite_log_store.py
node test_dashboard.js
```

Os testes são executados localmente. Não existe workflow automático de validação.
O único workflow mantido é o build manual dos executáveis.


## Estratégia para arquivos append-only

Exemplo: um log possui 4.873.221 bytes já indexados e cresce para 5.120.000.
A próxima sincronização valida a continuidade do prefixo e lê somente a partir
do byte 4.873.221. Se 246.779 bytes forem novos, somente esse trecho trafega
pela rede e é parseado.

Bancos criados pela versão anterior são migrados automaticamente para o schema
v2. Na primeira alteração de cada arquivo migrado sem assinatura de continuidade,
esse arquivo é reindexado uma única vez; a partir daí passa a usar leitura
incremental por offset.


## Retry de leitura em concorrência

Quando uma leitura encontra o SQLite ocupado, o aplicativo tenta novamente com
esperas progressivas de 8 s, 30 s e 90 s. O estado de cada tentativa é exposto
em /api/load-status e aparece na tela de carregamento/atualização.

Erros que não representam lock/busy não são mascarados pelo retry.
