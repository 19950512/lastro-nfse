CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

/* why: busca em português que ignora acento ("não" = "nao") e reduz ao radical ("obrigatória" = "obrigatório"). */
CREATE TEXT SEARCH CONFIGURATION lastro_pt (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION lastro_pt ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;

/* invariant: sem decisão "liberar", o snapshot de uma mudança anômala não entra no índice (SEGURANCA.md §8). */
CREATE TABLE revisao_anomalia (
  evento_id    uuid PRIMARY KEY REFERENCES evento_mudanca (id),
  decisao      text NOT NULL CHECK (decisao IN ('liberar', 'bloquear')),
  revisor      text NOT NULL CHECK (length(revisor) BETWEEN 1 AND 200),
  motivo       text NOT NULL CHECK (length(motivo) BETWEEN 1 AND 2000),
  decidida_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE extracao (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id      uuid NOT NULL REFERENCES snapshot (id),
  versao_extrator  text NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('texto', 'tabelas', 'leiaute', 'ignorado', 'falha')),
  detalhe          text,
  criada_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, versao_extrator)
);

CREATE TABLE trecho (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extracao_id   uuid NOT NULL REFERENCES extracao (id),
  snapshot_id   uuid NOT NULL REFERENCES snapshot (id),
  documento_id  uuid NOT NULL REFERENCES documento (id),
  fonte_id      text NOT NULL,
  ordem         integer NOT NULL CHECK (ordem >= 0),
  texto         text NOT NULL CHECK (length(texto) BETWEEN 1 AND 20000),
  pagina_ini    integer CHECK (pagina_ini >= 1),
  pagina_fim    integer CHECK (pagina_fim >= pagina_ini),
  secao         text CHECK (length(secao) <= 500),
  busca         tsvector GENERATED ALWAYS AS (to_tsvector('lastro_pt'::regconfig, coalesce(secao, '') || ' ' || texto)) STORED,
  UNIQUE (extracao_id, ordem)
);
CREATE INDEX trecho_busca ON trecho USING gin (busca);
CREATE INDEX trecho_texto_trgm ON trecho USING gin (texto gin_trgm_ops);

CREATE TABLE tabela_referencia (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extracao_id   uuid NOT NULL REFERENCES extracao (id),
  snapshot_id   uuid NOT NULL REFERENCES snapshot (id),
  documento_id  uuid NOT NULL REFERENCES documento (id),
  fonte_id      text NOT NULL,
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9-]{1,120}$'),
  titulo        text NOT NULL,
  planilha      text NOT NULL,
  colunas       text[] NOT NULL
);
CREATE INDEX tabela_referencia_slug ON tabela_referencia (slug);

CREATE TABLE linha_referencia (
  tabela_id  uuid NOT NULL REFERENCES tabela_referencia (id),
  ordem      integer NOT NULL CHECK (ordem >= 0),
  dados      jsonb NOT NULL,
  codigos    text[] NOT NULL,
  PRIMARY KEY (tabela_id, ordem)
);
CREATE INDEX linha_referencia_codigos ON linha_referencia USING gin (codigos);

CREATE TABLE campo_leiaute (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extracao_id      uuid NOT NULL REFERENCES extracao (id),
  snapshot_id      uuid NOT NULL REFERENCES snapshot (id),
  documento_id     uuid NOT NULL REFERENCES documento (id),
  fonte_id         text NOT NULL,
  nome             text NOT NULL,
  caminho          text NOT NULL,
  tipo             text,
  min_ocorrencias  integer NOT NULL,
  max_ocorrencias  text NOT NULL,
  descricao        text,
  arquivo          text NOT NULL
);
CREATE INDEX campo_leiaute_nome ON campo_leiaute (lower(nome));

/* invariant: versão indexável de cada documento = a mais recente que não está presa em revisão de anomalia.
   Se a última versão for anômala e não liberada, a anterior (confiável) continua sendo a usada. */
CREATE VIEW snapshot_indexavel AS
SELECT DISTINCT ON (s.documento_id) s.id AS snapshot_id, s.documento_id, s.fonte_id
  FROM snapshot s
 WHERE NOT EXISTS (
         SELECT 1 FROM evento_mudanca e
          WHERE e.snapshot_novo = s.id AND e.anomalia IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM revisao_anomalia r WHERE r.evento_id = e.id AND r.decisao = 'liberar'))
 ORDER BY s.documento_id, s.coletado_em DESC, s.id DESC;

CREATE VIEW extracao_vigente AS
SELECT DISTINCT ON (x.snapshot_id) x.id, x.snapshot_id, si.documento_id, si.fonte_id, x.tipo, x.versao_extrator, x.criada_em
  FROM extracao x JOIN snapshot_indexavel si ON si.snapshot_id = x.snapshot_id
 WHERE x.tipo IN ('texto', 'tabelas', 'leiaute')
 ORDER BY x.snapshot_id, x.criada_em DESC, x.id DESC;

CREATE TABLE cliente (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                   text NOT NULL CHECK (length(nome) BETWEEN 1 AND 200),
  criado_em              timestamptz NOT NULL DEFAULT now(),
  ativo                  boolean NOT NULL DEFAULT true,
  limite_por_minuto      integer NOT NULL DEFAULT 60 CHECK (limite_por_minuto BETWEEN 1 AND 100000),
  cota_mensal_perguntas  integer NOT NULL DEFAULT 1000 CHECK (cota_mensal_perguntas >= 0),
  orcamento_mensal_usd   numeric(12, 4) NOT NULL DEFAULT 50 CHECK (orcamento_mensal_usd >= 0)
);

/* invariant: só o hash (SHA-256) da chave fica no banco; o segredo aparece uma vez, na criação. */
CREATE TABLE chave_api (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id   uuid NOT NULL REFERENCES cliente (id),
  prefixo      text NOT NULL UNIQUE CHECK (prefixo ~ '^[a-z0-9]{12}$'),
  hash         text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  escopos      text[] NOT NULL CHECK (escopos <@ ARRAY['leitura', 'perguntas']::text[] AND cardinality(escopos) > 0),
  descricao    text,
  criada_em    timestamptz NOT NULL DEFAULT now(),
  revogada_em  timestamptz
);

CREATE TABLE consulta_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id      uuid NOT NULL REFERENCES cliente (id),
  chave_id        uuid REFERENCES chave_api (id),
  canal           text NOT NULL CHECK (canal IN ('api', 'mcp')),
  rota            text NOT NULL,
  situacao        text NOT NULL,
  pergunta        text NOT NULL CHECK (length(pergunta) <= 4000),
  resposta        jsonb NOT NULL,
  trechos         uuid[] NOT NULL DEFAULT '{}',
  modelo          text,
  tokens_entrada  integer NOT NULL DEFAULT 0,
  tokens_saida    integer NOT NULL DEFAULT 0,
  custo_usd       numeric(12, 6) NOT NULL DEFAULT 0,
  latencia_ms     integer NOT NULL DEFAULT 0,
  criada_em       timestamptz NOT NULL DEFAULT now(),
  expira_em       timestamptz NOT NULL
);
CREATE INDEX consulta_log_cliente ON consulta_log (cliente_id, criada_em);
CREATE INDEX consulta_log_expira ON consulta_log (expira_em);

/* invariant: segunda camada de isolamento entre clientes (a primeira é o filtro no código). O papel da API
   não tem BYPASSRLS; sem `lastro.cliente_id` definido na transação, não vê nem grava nenhuma linha. */
ALTER TABLE consulta_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE consulta_log FORCE ROW LEVEL SECURITY;
CREATE POLICY consulta_log_por_cliente ON consulta_log
  USING (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid)
  WITH CHECK (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid);

/* why: a API autentica pelo prefixo sem poder listar a tabela de chaves (nem hashes de outros clientes). */
CREATE FUNCTION autenticar_chave(p_prefixo text)
RETURNS TABLE (chave_id uuid, cliente_id uuid, hash text, escopos text[], limite_por_minuto integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.cliente_id, k.hash, k.escopos, c.limite_por_minuto
    FROM chave_api k JOIN cliente c ON c.id = k.cliente_id
   WHERE k.prefixo = p_prefixo AND k.revogada_em IS NULL AND c.ativo
$$;

/* why: o disjuntor global de gasto (SEGURANCA.md §11) soma todos os clientes, o que o RLS impede ao papel da API. */
CREATE FUNCTION gasto_llm_global(p_desde timestamptz) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(custo_usd), 0) FROM consulta_log WHERE criada_em >= p_desde
$$;

CREATE FUNCTION limites_cliente(p_cliente uuid)
RETURNS TABLE (cota_mensal_perguntas integer, orcamento_mensal_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cota_mensal_perguntas, orcamento_mensal_usd FROM cliente WHERE id = p_cliente AND ativo
$$;

REVOKE ALL ON FUNCTION autenticar_chave(text), gasto_llm_global(timestamptz), limites_cliente(uuid) FROM PUBLIC;

DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['revisao_anomalia', 'extracao', 'trecho', 'tabela_referencia', 'linha_referencia', 'campo_leiaute'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION recusar_alteracao()', tabela || '_so_insercao', tabela);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao()', tabela || '_sem_truncate', tabela);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO lastro_processador, lastro_api;

GRANT SELECT ON documento, snapshot, evento_mudanca, revisao_anomalia, extracao, snapshot_indexavel TO lastro_processador;
GRANT INSERT ON extracao, trecho, tabela_referencia, linha_referencia, campo_leiaute TO lastro_processador;

GRANT SELECT ON documento, snapshot, evento_mudanca, verificacao_coleta, trecho, tabela_referencia, linha_referencia,
  campo_leiaute, extracao_vigente, snapshot_indexavel TO lastro_api;
GRANT SELECT, INSERT ON consulta_log TO lastro_api;
GRANT EXECUTE ON FUNCTION autenticar_chave(text), gasto_llm_global(timestamptz), limites_cliente(uuid) TO lastro_api;

GRANT SELECT ON trecho, tabela_referencia, linha_referencia, campo_leiaute, extracao_vigente, snapshot_indexavel, revisao_anomalia TO lastro_leitor;
