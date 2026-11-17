/* invariant: limite efetivo de um cliente = exceção do próprio cliente, se houver, senão o valor do plano.
   Mudar um plano muda todos os clientes que não têm exceção naquele limite. */
CREATE TABLE plano (
  id                        text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  nome                      text NOT NULL CHECK (length(nome) BETWEEN 1 AND 200),
  limite_por_minuto         integer NOT NULL CHECK (limite_por_minuto BETWEEN 1 AND 100000),
  cota_mensal_perguntas     integer NOT NULL CHECK (cota_mensal_perguntas >= 0),
  cota_mensal_verificacoes  integer NOT NULL CHECK (cota_mensal_verificacoes >= 0),
  orcamento_mensal_usd      numeric(12, 4) NOT NULL CHECK (orcamento_mensal_usd >= 0),
  max_alertas               integer NOT NULL CHECK (max_alertas BETWEEN 0 AND 1000),
  criado_em                 timestamptz NOT NULL DEFAULT now()
);

/* why: valores provisórios. "padrao" reproduz os limites que todo cliente tinha até a Fase 3; o modelo de
   negócio (decisão em aberto nº 4) define os planos de verdade com `pnpm lastro plano criar`. */
INSERT INTO plano (id, nome, limite_por_minuto, cota_mensal_perguntas, cota_mensal_verificacoes, orcamento_mensal_usd, max_alertas) VALUES
  ('padrao', 'Padrão', 60, 1000, 1000, 50, 10),
  ('portal-publico', 'Portal público (anônimo)', 600, 3000, 1000, 30, 0);

ALTER TABLE cliente ADD COLUMN plano_id text NOT NULL DEFAULT 'padrao' REFERENCES plano (id);
ALTER TABLE cliente
  ALTER COLUMN limite_por_minuto DROP NOT NULL, ALTER COLUMN limite_por_minuto DROP DEFAULT,
  ALTER COLUMN cota_mensal_perguntas DROP NOT NULL, ALTER COLUMN cota_mensal_perguntas DROP DEFAULT,
  ALTER COLUMN orcamento_mensal_usd DROP NOT NULL, ALTER COLUMN orcamento_mensal_usd DROP DEFAULT;
ALTER TABLE cliente
  ADD COLUMN cota_mensal_verificacoes integer CHECK (cota_mensal_verificacoes >= 0),
  ADD COLUMN max_alertas integer CHECK (max_alertas BETWEEN 0 AND 1000);
/* why: quem tinha o padrão antigo passa a seguir o plano; valor diferente do padrão vira exceção do cliente. */
UPDATE cliente SET limite_por_minuto = nullif(limite_por_minuto, 60),
                   cota_mensal_perguntas = nullif(cota_mensal_perguntas, 1000),
                   orcamento_mensal_usd = nullif(orcamento_mensal_usd, 50);

CREATE VIEW cliente_limites AS
SELECT c.id AS cliente_id, c.ativo, c.plano_id, p.nome AS plano_nome,
       coalesce(c.limite_por_minuto, p.limite_por_minuto) AS limite_por_minuto,
       coalesce(c.cota_mensal_perguntas, p.cota_mensal_perguntas) AS cota_mensal_perguntas,
       coalesce(c.cota_mensal_verificacoes, p.cota_mensal_verificacoes) AS cota_mensal_verificacoes,
       coalesce(c.orcamento_mensal_usd, p.orcamento_mensal_usd) AS orcamento_mensal_usd,
       coalesce(c.max_alertas, p.max_alertas) AS max_alertas
  FROM cliente c JOIN plano p ON p.id = c.plano_id;

CREATE OR REPLACE FUNCTION autenticar_chave(p_prefixo text)
RETURNS TABLE (chave_id uuid, cliente_id uuid, hash text, escopos text[], limite_por_minuto integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.cliente_id, k.hash, k.escopos, l.limite_por_minuto
    FROM chave_api k JOIN cliente_limites l ON l.cliente_id = k.cliente_id
   WHERE k.prefixo = p_prefixo AND k.revogada_em IS NULL AND l.ativo
$$;

DROP FUNCTION limites_cliente(uuid);
CREATE FUNCTION limites_cliente(p_cliente uuid)
RETURNS TABLE (plano_id text, plano_nome text, limite_por_minuto integer, cota_mensal_perguntas integer,
               cota_mensal_verificacoes integer, orcamento_mensal_usd numeric, max_alertas integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT plano_id, plano_nome, limite_por_minuto, cota_mensal_perguntas, cota_mensal_verificacoes, orcamento_mensal_usd, max_alertas
    FROM cliente_limites WHERE cliente_id = p_cliente AND ativo
$$;

/* invariant: medição agregada por dia (UTC), sem conteúdo de cliente. Não expira com a retenção de
   consulta_log (LGPD): é a base da cota mensal, do disjuntor de gasto e da cobrança. */
CREATE TABLE uso_diario (
  cliente_id  uuid NOT NULL REFERENCES cliente (id),
  dia         date NOT NULL,
  metrica     text NOT NULL CHECK (metrica IN ('requisicoes', 'perguntas', 'perguntas-fora-do-escopo', 'verificacoes')),
  quantidade  bigint NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  custo_usd   numeric(14, 6) NOT NULL DEFAULT 0 CHECK (custo_usd >= 0),
  PRIMARY KEY (cliente_id, dia, metrica)
);
CREATE INDEX uso_diario_dia ON uso_diario (dia);

/* why: sem FORCE; as funções SECURITY DEFINER (dono) gravam e somam todos os clientes, e o papel da API só lê
   o próprio cliente. */
ALTER TABLE uso_diario ENABLE ROW LEVEL SECURITY;
CREATE POLICY uso_diario_por_cliente ON uso_diario FOR SELECT TO lastro_api
  USING (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid);

/* invariant: toda consulta com LLM registrada em consulta_log entra na medição na mesma transação; a API
   não consegue gravar uma consulta sem contar o uso (nem contar sem gravar). */
CREATE FUNCTION medir_consulta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO uso_diario (cliente_id, dia, metrica, quantidade, custo_usd)
  VALUES (NEW.cliente_id, (NEW.criada_em AT TIME ZONE 'UTC')::date,
          CASE NEW.rota WHEN 'verificacao' THEN 'verificacoes' WHEN 'fora-do-escopo' THEN 'perguntas-fora-do-escopo' ELSE 'perguntas' END,
          1, NEW.custo_usd)
  ON CONFLICT (cliente_id, dia, metrica)
  DO UPDATE SET quantidade = uso_diario.quantidade + 1, custo_usd = uso_diario.custo_usd + EXCLUDED.custo_usd;
  RETURN NULL;
END
$$;
CREATE TRIGGER consulta_log_medicao AFTER INSERT ON consulta_log FOR EACH ROW EXECUTE FUNCTION medir_consulta();

INSERT INTO uso_diario (cliente_id, dia, metrica, quantidade, custo_usd)
SELECT cliente_id, (criada_em AT TIME ZONE 'UTC')::date,
       CASE rota WHEN 'verificacao' THEN 'verificacoes' WHEN 'fora-do-escopo' THEN 'perguntas-fora-do-escopo' ELSE 'perguntas' END,
       count(*), sum(custo_usd)
  FROM consulta_log GROUP BY 1, 2, 3;

/* why: a API conta requisições em memória e grava em lote; uma chamada por lote, agregada aqui (o mesmo
   cliente e dia duas vezes no lote faria o ON CONFLICT falhar). */
CREATE FUNCTION registrar_requisicoes(p_itens jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO uso_diario (cliente_id, dia, metrica, quantidade)
  SELECT (i ->> 'cliente_id')::uuid, (i ->> 'dia')::date, 'requisicoes', sum((i ->> 'quantidade')::bigint)
    FROM jsonb_array_elements(p_itens) i
   WHERE (i ->> 'quantidade')::bigint > 0
   GROUP BY 1, 2
  ON CONFLICT (cliente_id, dia, metrica) DO UPDATE SET quantidade = uso_diario.quantidade + EXCLUDED.quantidade
$$;

CREATE OR REPLACE FUNCTION gasto_llm_global(p_desde timestamptz) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(custo_usd), 0) FROM uso_diario WHERE dia >= (p_desde AT TIME ZONE 'UTC')::date
$$;

REVOKE ALL ON FUNCTION limites_cliente(uuid), registrar_requisicoes(jsonb), medir_consulta() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION limites_cliente(uuid), registrar_requisicoes(jsonb) TO lastro_api;
GRANT SELECT ON uso_diario TO lastro_api;

/* why: novos canais de entrada (portal público e bot de Slack) ficam registrados como tal. */
ALTER TABLE consulta_log DROP CONSTRAINT consulta_log_canal_check;
ALTER TABLE consulta_log ADD CONSTRAINT consulta_log_canal_check CHECK (canal IN ('api', 'mcp', 'portal', 'slack'));
ALTER TABLE verificacao DROP CONSTRAINT verificacao_canal_check;
ALTER TABLE verificacao ADD CONSTRAINT verificacao_canal_check CHECK (canal IN ('api', 'mcp', 'portal', 'slack'));

/* why: alerta por tema é assinatura de webhook do próprio cliente; o cliente cria pela API (escopo próprio). */
ALTER TABLE chave_api DROP CONSTRAINT chave_api_escopos_check;
ALTER TABLE chave_api ADD CONSTRAINT chave_api_escopos_check
  CHECK (escopos <@ ARRAY['leitura', 'perguntas', 'verificacoes', 'alertas']::text[] AND cardinality(escopos) > 0);

ALTER TABLE evento_mudanca DROP CONSTRAINT evento_mudanca_tipo_check;
ALTER TABLE evento_mudanca ADD CONSTRAINT evento_mudanca_tipo_check CHECK (
  tipo IN ('documento-novo', 'nova-versao', 'link-removido', 'documento-indisponivel', 'documento-restabelecido', 'fato-corrigido', 'fato-aprovado')
);
ALTER TABLE evento_mudanca ADD COLUMN fato_id uuid REFERENCES fato (id);
ALTER TABLE evento_mudanca ADD CONSTRAINT evento_mudanca_fato_check CHECK (fato_id IS NULL OR tipo IN ('fato-corrigido', 'fato-aprovado'));
CREATE INDEX evento_mudanca_fato ON evento_mudanca (fato_id) WHERE fato_id IS NOT NULL;

/* invariant: a segunda aprovação (a que torna o fato aprovado) publica um evento no feed, na mesma transação.
   Não há terceira aprovação (checar_decisao recusa decidir o que já não está "proposto"), então sai um só. */
CREATE FUNCTION publicar_fato_aprovado() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.fato_id IS NULL OR NEW.decisao <> 'aprovar' OR situacao_curadoria(NEW.fato_id, NULL) <> 'aprovado' THEN
    RETURN NULL;
  END IF;
  INSERT INTO evento_mudanca (tipo, fonte_id, documento_id, snapshot_anterior, snapshot_novo, detectado_em, resumo, anomalia, fato_id)
  SELECT 'fato-aprovado', t.fonte_id, t.documento_id, NULL, t.snapshot_id, now(),
         'Fato aprovado pela curadoria (' || f.tema || '): ' || left(f.enunciado, 300), NULL, f.id
    FROM fato f JOIN trecho t ON t.id = f.evidencia_trecho_id
   WHERE f.id = NEW.fato_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER decisao_curadoria_evento AFTER INSERT ON decisao_curadoria FOR EACH ROW EXECUTE FUNCTION publicar_fato_aprovado();

CREATE OR REPLACE FUNCTION registrar_recall(p_fato uuid, p_curador uuid, p_motivo text)
RETURNS TABLE (verificacoes bigint, consultas bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO decisao_curadoria (fato_id, curador_id, decisao, motivo) VALUES (p_fato, p_curador, 'revogar', p_motivo);
  INSERT INTO evento_mudanca (tipo, fonte_id, documento_id, snapshot_anterior, snapshot_novo, detectado_em, resumo, anomalia, fato_id)
  SELECT 'fato-corrigido', t.fonte_id, t.documento_id, NULL, t.snapshot_id, now(),
         'Fato revogado pela curadoria: ' || left(f.enunciado, 300), NULL, f.id
    FROM fato f JOIN trecho t ON t.id = f.evidencia_trecho_id
   WHERE f.id = p_fato;
  RETURN QUERY
  SELECT (SELECT count(*) FROM verificacao v WHERE p_fato = ANY (v.fatos)),
         (SELECT count(*) FROM consulta_log c JOIN fato f ON f.id = p_fato WHERE f.evidencia_trecho_id = ANY (c.trechos));
END
$$;

ALTER TABLE webhook_assinatura
  ADD COLUMN cliente_id uuid REFERENCES cliente (id),
  ADD COLUMN nome text CHECK (length(nome) BETWEEN 1 AND 120),
  ADD COLUMN termos text[] CHECK (cardinality(termos) BETWEEN 1 AND 20),
  ADD COLUMN temas text[] CHECK (cardinality(temas) BETWEEN 1 AND 20);
CREATE INDEX webhook_assinatura_cliente ON webhook_assinatura (cliente_id) WHERE cliente_id IS NOT NULL;

/* invariant: cada cliente vê e altera só os próprios alertas; o notificador lê todos para despachar. O dono
   (admin, linha de comando) não está sujeito ao RLS e continua cuidando das assinaturas do operador. */
ALTER TABLE webhook_assinatura ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_assinatura_notificador ON webhook_assinatura TO lastro_notificador USING (true) WITH CHECK (true);
CREATE POLICY webhook_assinatura_por_cliente ON webhook_assinatura TO lastro_api
  USING (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid)
  WITH CHECK (cliente_id = nullif(current_setting('lastro.cliente_id', true), '')::uuid);

/* hazard: o segredo HMAC fica fora do SELECT da API; ele aparece só uma vez, na criação, gerado pelo servidor. */
GRANT SELECT (id, cliente_id, nome, url, formato, fontes, tipos, termos, temas, criada_em, ativa, falhas_consecutivas, desativada_em, motivo_desativacao)
  ON webhook_assinatura TO lastro_api;
GRANT INSERT (cliente_id, nome, url, formato, segredo, fontes, tipos, termos, temas) ON webhook_assinatura TO lastro_api;
GRANT UPDATE (ativa, desativada_em, motivo_desativacao) ON webhook_assinatura TO lastro_api;

/* why: o despacho casa termos com o texto que mudou (trechos novos da versão) e temas com fatos aprovados. */
GRANT SELECT (id, snapshot_id, documento_id, texto, busca) ON trecho TO lastro_notificador;
GRANT SELECT ON fato_publico TO lastro_notificador;
/* why: "versão anterior" para o diff de termos é a mais recente já processada, que pode não ser o snapshot_anterior
   do evento (duas versões entre rodadas de `processar`); a ordem vem de coletado_em. Só estas colunas. */
GRANT SELECT (id, documento_id, coletado_em) ON snapshot TO lastro_notificador;
CREATE INDEX trecho_snapshot ON trecho (snapshot_id);
CREATE INDEX trecho_documento ON trecho (documento_id);
/* why: função chamada dentro de view é conferida contra quem consulta a view, não contra o dono. */
GRANT EXECUTE ON FUNCTION situacao_curadoria(uuid, uuid) TO lastro_notificador;

/* invariant: um workspace do Slack fala em nome de um cliente só; sem vínculo ativo, o comando é recusado. */
CREATE TABLE canal_slack (
  team_id     text PRIMARY KEY CHECK (team_id ~ '^T[A-Z0-9]{2,30}$'),
  cliente_id  uuid NOT NULL REFERENCES cliente (id),
  ativo       boolean NOT NULL DEFAULT true,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION cliente_do_slack(p_team text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.cliente_id FROM canal_slack s JOIN cliente c ON c.id = s.cliente_id WHERE s.team_id = p_team AND s.ativo AND c.ativo
$$;
REVOKE ALL ON FUNCTION cliente_do_slack(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cliente_do_slack(text) TO lastro_api;
