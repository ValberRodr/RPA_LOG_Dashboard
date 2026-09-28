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
5. A sincronização usa duas proteções para não reler arquivos sem necessidade:
   - data mais recente registrada por processo/RPA e por VM;
   - manifesto por arquivo com caminho, mtime e tamanho.
6. Com **Todos os logs** selecionado, **Atualizar** percorre o manifesto do
   histórico completo, mas só reparseia arquivos novos ou cujo mtime/tamanho
   mudou.

## Estrutura

- `source_files`: manifesto dos arquivos já processados.
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

O workflow **Validar aplicação** executa a suíte automaticamente em mudanças
relevantes. O workflow de build também executa os testes antes de gerar os
executáveis.
