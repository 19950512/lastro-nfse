/* why: o recall de um fato aprovado é avisado aos assinantes de webhook pelo mesmo feed (SEGURANCA.md §13). */
ALTER TABLE evento_mudanca DROP CONSTRAINT evento_mudanca_tipo_check;
ALTER TABLE evento_mudanca ADD CONSTRAINT evento_mudanca_tipo_check CHECK (
  tipo IN ('documento-novo', 'nova-versao', 'link-removido', 'documento-indisponivel', 'documento-restabelecido', 'fato-corrigido')
);

/* invariant: curador é identificado pelo par (emissor, sujeito) do SSO; nenhuma senha passa por aqui. */
CREATE TABLE curador (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emissor    text NOT NULL CHECK (emissor LIKE 'https://%'),
  sujeito    text NOT NULL CHECK (length(sujeito) BETWEEN 1 AND 255),
  nome       text NOT NULL CHECK (length(nome) BETWEEN 1 AND 200),
  papel      text NOT NULL CHECK (papel IN ('curador', 'supervisor')),
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emissor, sujeito)
);

/* invariant: só hashes de estado e de sessão ficam no banco; o valor bruto existe só no cookie do navegador. */
CREATE TABLE login_oidc (
  hash_estado  text PRIMARY KEY CHECK (hash_estado ~ '^[0-9a-f]{64}$'),
  nonce        text NOT NULL CHECK (length(nonce) BETWEEN 32 AND 128),
  verificador  text NOT NULL CHECK (length(verificador) BETWEEN 43 AND 128),
  expira_em    timestamptz NOT NULL
);

CREATE TABLE sessao_curador (
  hash        text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  curador_id  uuid NOT NULL REFERENCES curador (id),
  amr         text[] NOT NULL,
  criada_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL
);
CREATE INDEX sessao_curador_expira ON sessao_curador (expira_em);

/* invariant: uma linha por snapshot e extrator (regras ou modelo); sem ela o snapshot volta à fila. */
CREATE TABLE extracao_normativa (
  snapshot_id  uuid NOT NULL REFERENCES snapshot (id),
  extrator     text NOT NULL CHECK (length(extrator) BETWEEN 1 AND 80),
  itens        integer NOT NULL CHECK (itens >= 0),
  detalhe      text CHECK (length(detalhe) <= 2000),
  criada_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, extrator)
);

CREATE TABLE metadado_ato (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id          uuid NOT NULL REFERENCES snapshot (id),
  documento_id         uuid NOT NULL REFERENCES documento (id),
  extrator             text NOT NULL CHECK (length(extrator) BETWEEN 1 AND 80),
  chave                text NOT NULL CHECK (chave ~ '^[a-z0-9-]{3,160}$'),
  tipo                 text NOT NULL CHECK (length(tipo) BETWEEN 1 AND 80),
  numero               text NOT NULL CHECK (length(numero) BETWEEN 1 AND 40),
  orgao                text CHECK (length(orgao) <= 120),
  data_ato             date,
  titulo               text NOT NULL CHECK (length(titulo) BETWEEN 1 AND 500),
  evidencia_trecho_id  uuid NOT NULL REFERENCES trecho (id),
  criado_em            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, extrator)
);
CREATE INDEX metadado_ato_chave ON metadado_ato (chave);

/* invariant: identificação vigente de cada documento = a da versão indexável (a anômala não liberada não conta),
   dada pela rodada mais recente do extrator de regras naquela versão. Se uma versão nova das regras deixa de
   identificar um documento, o rótulo da versão anterior das regras deixa de valer junto. */
CREATE VIEW ato_vigente AS
SELECT DISTINCT ON (m.documento_id) m.documento_id, m.snapshot_id, m.chave, m.tipo, m.numero, m.orgao, m.data_ato, m.titulo
  FROM metadado_ato m JOIN snapshot_indexavel si ON si.snapshot_id = m.snapshot_id
 WHERE m.extrator = (SELECT n.extrator FROM extracao_normativa n
                      WHERE n.snapshot_id = m.snapshot_id AND n.extrator LIKE 'regras-%'
                      ORDER BY n.criada_em DESC LIMIT 1)
 ORDER BY m.documento_id, m.criado_em DESC, m.id DESC;

CREATE TABLE relacao_normativa (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem_documento_id   uuid NOT NULL REFERENCES documento (id),
  tipo                  text NOT NULL CHECK (tipo IN ('altera', 'revoga', 'prorroga', 'regulamenta')),
  destino_chave         text CHECK (destino_chave ~ '^[a-z0-9-]{3,160}$'),
  destino_descricao     text NOT NULL CHECK (length(destino_descricao) BETWEEN 1 AND 500),
  destino_documento_id  uuid REFERENCES documento (id),
  dispositivo           text CHECK (length(dispositivo) <= 500),
  efeito_em             date,
  evidencia_trecho_id   uuid NOT NULL REFERENCES trecho (id),
  evidencia_texto       text NOT NULL CHECK (length(evidencia_texto) BETWEEN 1 AND 2000),
  extrator              text NOT NULL CHECK (length(extrator) BETWEEN 1 AND 80),
  proposto_por          uuid REFERENCES curador (id),
  proposto_em           timestamptz NOT NULL DEFAULT now(),
  CHECK (destino_documento_id IS DISTINCT FROM origem_documento_id),
  CHECK (destino_chave IS NOT NULL OR destino_documento_id IS NOT NULL)
);
CREATE UNIQUE INDEX relacao_normativa_unica ON relacao_normativa (evidencia_trecho_id, tipo, destino_descricao);
CREATE INDEX relacao_normativa_destino ON relacao_normativa (destino_chave);

CREATE TABLE fato (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                 text NOT NULL CHECK (tipo IN ('prazo', 'obrigacao', 'vigencia', 'valor', 'pendente')),
  tema                 text NOT NULL CHECK (tema ~ '^[a-z0-9-]{2,80}$'),
  enunciado            text NOT NULL CHECK (length(enunciado) BETWEEN 10 AND 1000),
  publico              text CHECK (length(publico) <= 300),
  data_efeito          date,
  evidencia_trecho_id  uuid NOT NULL REFERENCES trecho (id),
  evidencia_texto      text NOT NULL CHECK (length(evidencia_texto) BETWEEN 1 AND 2000),
  substitui            uuid REFERENCES fato (id),
  extrator             text NOT NULL CHECK (length(extrator) BETWEEN 1 AND 80),
  proposto_por         uuid REFERENCES curador (id),
  proposto_em          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fato_unico ON fato (evidencia_trecho_id, tipo, md5(enunciado));
CREATE INDEX fato_busca ON fato USING gin (to_tsvector('lastro_pt'::regconfig, tema || ' ' || enunciado || ' ' || coalesce(publico, '')));

/* invariant: a evidência de fato e de relação existe literalmente no trecho arquivado; o curador vê o texto
   original ao lado, e um extrator (modelo ou regra) não consegue inventar a citação. */
CREATE FUNCTION exigir_evidencia_literal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trecho t WHERE t.id = NEW.evidencia_trecho_id AND strpos(t.texto, NEW.evidencia_texto) > 0) THEN
    RAISE EXCEPTION 'evidência não encontrada literalmente no trecho %', NEW.evidencia_trecho_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER relacao_evidencia_literal BEFORE INSERT ON relacao_normativa FOR EACH ROW EXECUTE FUNCTION exigir_evidencia_literal();
CREATE TRIGGER fato_evidencia_literal BEFORE INSERT ON fato FOR EACH ROW EXECUTE FUNCTION exigir_evidencia_literal();

/* invariant: proposta feita pelo painel leva o curador da sessão como proponente; sem isso um curador gravaria a
   proposta em nome de outro (ou como "automática") e aprovaria a própria, furando a dupla aprovação. */
CREATE FUNCTION exigir_proponente() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'lastro_curadoria'
     AND NEW.proposto_por IS DISTINCT FROM nullif(current_setting('lastro.curador_id', true), '')::uuid THEN
    RAISE EXCEPTION 'proposta em nome de outro curador' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER relacao_proponente BEFORE INSERT ON relacao_normativa FOR EACH ROW EXECUTE FUNCTION exigir_proponente();
CREATE TRIGGER fato_proponente BEFORE INSERT ON fato FOR EACH ROW EXECUTE FUNCTION exigir_proponente();

/* invariant: trilha de auditoria da curadoria só aceita inserção (SEGURANCA.md §13). */
CREATE TABLE decisao_curadoria (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fato_id      uuid REFERENCES fato (id),
  relacao_id   uuid REFERENCES relacao_normativa (id),
  curador_id   uuid NOT NULL REFERENCES curador (id),
  decisao      text NOT NULL CHECK (decisao IN ('aprovar', 'rejeitar', 'revogar')),
  motivo       text CHECK (length(motivo) <= 2000),
  decidida_em  timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(fato_id, relacao_id) = 1),
  CHECK (decisao = 'aprovar' OR length(btrim(motivo)) >= 3)
);
CREATE UNIQUE INDEX decisao_curadoria_unica ON decisao_curadoria (coalesce(fato_id, relacao_id), curador_id, decisao);
CREATE INDEX decisao_curadoria_fato ON decisao_curadoria (fato_id) WHERE fato_id IS NOT NULL;
CREATE INDEX decisao_curadoria_relacao ON decisao_curadoria (relacao_id) WHERE relacao_id IS NOT NULL;

/* invariant: aprovado = dois curadores distintos aprovaram (dupla aprovação, SEGURANCA.md A06) e ninguém rejeitou;
   revogado = recall de um supervisor depois da aprovação. */
/* why: SECURITY DEFINER porque as views públicas a chamam com o privilégio de quem consulta, e o papel da API
   não lê decisao_curadoria (nem quem decidiu); a função só devolve a situação. */
CREATE FUNCTION situacao_curadoria(p_fato uuid, p_relacao uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           WHEN coalesce(bool_or(d.decisao = 'revogar'), false) THEN 'revogado'
           WHEN coalesce(bool_or(d.decisao = 'rejeitar'), false) THEN 'rejeitado'
           WHEN count(DISTINCT d.curador_id) FILTER (WHERE d.decisao = 'aprovar') >= 2 THEN 'aprovado'
           ELSE 'proposto'
         END
    FROM decisao_curadoria d
   WHERE (p_fato IS NOT NULL AND d.fato_id = p_fato) OR (p_relacao IS NOT NULL AND d.relacao_id = p_relacao)
$$;

/* invariant: segunda camada do RBAC da curadoria (a primeira é o painel). Quem decide é o curador da sessão,
   ativo, que não propôs o que aprova; só supervisor faz recall, e só do que está aprovado. A advisory lock
   serializa decisões simultâneas sobre a mesma proposta (aprovar e rejeitar ao mesmo tempo). A hora gravada
   é a do servidor. */
CREATE FUNCTION checar_decisao() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_papel text;
  v_ativo boolean;
  v_proponente uuid;
  v_situacao text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('curadoria:' || coalesce(NEW.fato_id, NEW.relacao_id)::text));
  IF NEW.curador_id IS DISTINCT FROM nullif(current_setting('lastro.curador_id', true), '')::uuid THEN
    RAISE EXCEPTION 'decisão em nome de outro curador' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT papel, ativo INTO v_papel, v_ativo FROM curador WHERE id = NEW.curador_id;
  IF NOT coalesce(v_ativo, false) THEN
    RAISE EXCEPTION 'curador inativo ou inexistente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.fato_id IS NOT NULL THEN
    SELECT proposto_por INTO v_proponente FROM fato WHERE id = NEW.fato_id;
  ELSE
    SELECT proposto_por INTO v_proponente FROM relacao_normativa WHERE id = NEW.relacao_id;
  END IF;
  v_situacao := situacao_curadoria(NEW.fato_id, NEW.relacao_id);
  IF NEW.decisao = 'revogar' THEN
    IF v_papel <> 'supervisor' THEN
      RAISE EXCEPTION 'só supervisor faz recall' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_situacao <> 'aprovado' THEN
      RAISE EXCEPTION 'recall só de proposta aprovada (situação: %)', v_situacao USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF v_situacao <> 'proposto' THEN
      RAISE EXCEPTION 'proposta já decidida (situação: %)', v_situacao USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.decisao = 'aprovar' AND v_proponente IS NOT DISTINCT FROM NEW.curador_id THEN
      RAISE EXCEPTION 'quem propôs não aprova a própria proposta' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  NEW.decidida_em := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER decisao_curadoria_regras BEFORE INSERT ON decisao_curadoria FOR EACH ROW EXECUTE FUNCTION checar_decisao();

CREATE VIEW relacao_curadoria AS
SELECT r.*,
       coalesce(r.destino_documento_id,
                (SELECT min(a.documento_id::text)::uuid FROM ato_vigente a WHERE a.chave = r.destino_chave
                  HAVING count(*) = 1)) AS destino_resolvido,
       situacao_curadoria(NULL, r.id) AS situacao,
       (SELECT max(d.decidida_em) FROM decisao_curadoria d WHERE d.relacao_id = r.id AND d.decisao = 'aprovar') AS aprovada_em,
       EXISTS (SELECT 1 FROM trecho t JOIN extracao_vigente x ON x.id = t.extracao_id WHERE t.id = r.evidencia_trecho_id) AS evidencia_atual
  FROM relacao_normativa r;

CREATE VIEW fato_curadoria AS
SELECT f.*,
       CASE
         WHEN s.situacao = 'aprovado'
              AND EXISTS (SELECT 1 FROM fato n WHERE n.substitui = f.id AND situacao_curadoria(n.id, NULL) = 'aprovado')
           THEN 'superado'
         ELSE s.situacao
       END AS situacao,
       (SELECT max(d.decidida_em) FROM decisao_curadoria d WHERE d.fato_id = f.id AND d.decisao = 'aprovar') AS aprovado_em,
       EXISTS (SELECT 1 FROM trecho t JOIN extracao_vigente x ON x.id = t.extracao_id WHERE t.id = f.evidencia_trecho_id) AS evidencia_atual
  FROM fato f CROSS JOIN LATERAL (SELECT situacao_curadoria(f.id, NULL) AS situacao) s;

/* why: a API e o MCP só enxergam o que passou pela curadoria (e o que foi revogado depois, para avisar o recall);
   propostas pendentes e a identidade dos curadores ficam só no painel. */
CREATE VIEW fato_publico AS
SELECT id, tipo, tema, enunciado, publico, data_efeito, evidencia_trecho_id, evidencia_texto, substitui, situacao, aprovado_em, evidencia_atual
  FROM fato_curadoria WHERE situacao IN ('aprovado', 'superado', 'revogado');

CREATE VIEW relacao_publica AS
SELECT id, origem_documento_id, tipo, destino_chave, destino_descricao, destino_resolvido, dispositivo, efeito_em, evidencia_trecho_id,
       evidencia_texto, situacao, aprovada_em, evidencia_atual
  FROM relacao_curadoria WHERE situacao IN ('aprovado', 'revogado');

CREATE TABLE verificacao (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id        uuid NOT NULL REFERENCES cliente (id),
  chave_id          uuid REFERENCES chave_api (id),
  canal             text NOT NULL CHECK (canal IN ('api', 'mcp')),
  entrada           text NOT NULL CHECK (length(entrada) <= 5000),
  resultado         jsonb NOT NULL,
  fatos             uuid[] NOT NULL DEFAULT '{}',
  relacoes          uuid[] NOT NULL DEFAULT '{}',
  trechos           uuid[] NOT NULL DEFAULT '{}',
  compartilhamento  text UNIQUE CHECK (compartilhamento ~ '^[0-9a-f]{64}$'),
  compartilhada_em  timestamptz,
  criada_em         timestamptz NOT NULL DEFAULT now(),
  expira_em         timestamptz NOT NULL
);
CREATE INDEX verificacao_cliente ON verificacao (cliente_id, criada_em);
CREATE INDEX verificacao_expira ON verificacao (expira_em);
CREATE INDEX verificacao_fatos ON verificacao USING gin (fatos);

/* invariant: mesmo isolamento de consulta_log; sem `lastro.cliente_id` na transação nada é lido nem gravado. */
ALTER TABLE verificacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE verificacao FORCE ROW LEVEL SECURITY;
CREATE POLICY verificacao_por_cliente ON verificacao
  USING (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid)
  WITH CHECK (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid);

/* why: o link compartilhável é público; a página só recebe a verificação cujo hash de token bate, sem a entrada
   original (pode conter dado pessoal) e sem identificação do cliente. */
CREATE FUNCTION verificacao_compartilhada(p_hash text)
RETURNS TABLE (id uuid, resultado jsonb, fatos uuid[], relacoes uuid[], criada_em timestamptz, expira_em timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, v.resultado, v.fatos, v.relacoes, v.criada_em, v.expira_em
    FROM verificacao v
   WHERE v.compartilhamento = p_hash AND v.expira_em > now()
$$;

/* why: recall (SEGURANCA.md §13) numa transação só: a decisão de revogar, o evento no feed que os webhooks
   entregam e a contagem de verificações e respostas que usaram o fato (sem ler conteúdo de cliente). */
CREATE FUNCTION registrar_recall(p_fato uuid, p_curador uuid, p_motivo text)
RETURNS TABLE (verificacoes bigint, consultas bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO decisao_curadoria (fato_id, curador_id, decisao, motivo) VALUES (p_fato, p_curador, 'revogar', p_motivo);
  INSERT INTO evento_mudanca (tipo, fonte_id, documento_id, snapshot_anterior, snapshot_novo, detectado_em, resumo, anomalia)
  SELECT 'fato-corrigido', t.fonte_id, t.documento_id, NULL, t.snapshot_id, now(),
         'Fato revogado pela curadoria: ' || left(f.enunciado, 300), NULL
    FROM fato f JOIN trecho t ON t.id = f.evidencia_trecho_id
   WHERE f.id = p_fato;
  RETURN QUERY
  SELECT (SELECT count(*) FROM verificacao v WHERE p_fato = ANY (v.fatos)),
         (SELECT count(*) FROM consulta_log c JOIN fato f ON f.id = p_fato WHERE f.evidencia_trecho_id = ANY (c.trechos));
END
$$;

/* why: o painel mostra quantas verificações e respostas usaram um fato, sem ler o conteúdo de nenhum cliente. */
CREATE FUNCTION uso_do_fato(p_fato uuid) RETURNS TABLE (verificacoes bigint, consultas bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM verificacao v WHERE p_fato = ANY (v.fatos)),
         (SELECT count(*) FROM consulta_log c JOIN fato f ON f.id = p_fato WHERE f.evidencia_trecho_id = ANY (c.trechos))
$$;

REVOKE ALL ON FUNCTION verificacao_compartilhada(text), registrar_recall(uuid, uuid, text), uso_do_fato(uuid), checar_decisao(),
  situacao_curadoria(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION situacao_curadoria(uuid, uuid) TO lastro_api, lastro_curadoria, lastro_leitor;

DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['extracao_normativa', 'metadado_ato', 'relacao_normativa', 'fato', 'decisao_curadoria'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION recusar_alteracao()', tabela || '_so_insercao', tabela);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao()', tabela || '_sem_truncate', tabela);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO lastro_curadoria;

/* invariant: o processador lê o índice e propõe; nunca decide. */
GRANT SELECT ON trecho, extracao_vigente, ato_vigente, extracao_normativa TO lastro_processador;
GRANT INSERT ON extracao_normativa, metadado_ato, relacao_normativa, fato TO lastro_processador;

/* invariant: o painel de curadoria propõe fatos, decide e faz recall só pela função; não altera nem apaga nada. */
GRANT SELECT ON curador, documento, snapshot, trecho, extracao_vigente, snapshot_indexavel, ato_vigente, metadado_ato,
  relacao_normativa, fato, decisao_curadoria, relacao_curadoria, fato_curadoria TO lastro_curadoria;
GRANT INSERT ON fato, relacao_normativa, decisao_curadoria TO lastro_curadoria;
GRANT SELECT, INSERT, DELETE ON login_oidc, sessao_curador TO lastro_curadoria;
GRANT EXECUTE ON FUNCTION registrar_recall(uuid, uuid, text), uso_do_fato(uuid) TO lastro_curadoria;

/* invariant: a API vê só o que a curadoria aprovou, as verificações do próprio cliente (RLS) e a leitura pública por token. */
GRANT SELECT ON fato_publico, relacao_publica, ato_vigente TO lastro_api;
GRANT SELECT, INSERT ON verificacao TO lastro_api;
GRANT UPDATE (compartilhamento, compartilhada_em) ON verificacao TO lastro_api;
GRANT EXECUTE ON FUNCTION verificacao_compartilhada(text) TO lastro_api;

GRANT SELECT ON fato_publico, relacao_publica, ato_vigente TO lastro_leitor;

/* why: verificação tem custo e superfície próprios (link público); a chave precisa do escopo explícito. */
ALTER TABLE chave_api DROP CONSTRAINT chave_api_escopos_check;
ALTER TABLE chave_api ADD CONSTRAINT chave_api_escopos_check
  CHECK (escopos <@ ARRAY['leitura', 'perguntas', 'verificacoes']::text[] AND cardinality(escopos) > 0);
