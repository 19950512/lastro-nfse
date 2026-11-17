CREATE TABLE documento (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fonte_id    text NOT NULL,
  url         text NOT NULL UNIQUE CHECK (url LIKE 'https://%'),
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE snapshot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id        uuid NOT NULL REFERENCES documento (id),
  fonte_id            text NOT NULL,
  url_final           text NOT NULL CHECK (url_final LIKE 'https://%'),
  coletado_em         timestamptz NOT NULL,
  sha256              text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  impressao           text NOT NULL,
  bytes               bigint NOT NULL CHECK (bytes >= 0),
  mime                text NOT NULL,
  etag                text,
  ultima_modificacao  text,
  chave_storage       text NOT NULL
);
CREATE INDEX snapshot_documento_recente ON snapshot (documento_id, coletado_em DESC);
CREATE INDEX snapshot_sha256 ON snapshot (sha256);

CREATE TABLE evento_mudanca (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo               text NOT NULL CHECK (tipo IN ('documento-novo', 'nova-versao', 'link-removido')),
  fonte_id           text NOT NULL,
  documento_id       uuid NOT NULL REFERENCES documento (id),
  snapshot_anterior  uuid REFERENCES snapshot (id),
  snapshot_novo      uuid REFERENCES snapshot (id),
  detectado_em       timestamptz NOT NULL,
  resumo             text NOT NULL
);
CREATE INDEX evento_mudanca_detectado_em ON evento_mudanca (detectado_em);

CREATE TABLE verificacao_coleta (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento_id   uuid NOT NULL REFERENCES documento (id),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  verificado_em  timestamptz NOT NULL
);
CREATE INDEX verificacao_coleta_documento ON verificacao_coleta (documento_id, verificado_em DESC);

CREATE FUNCTION recusar_alteracao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabela % aceita apenas inserção (% recusado)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DO $$
DECLARE
  tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['documento', 'snapshot', 'evento_mudanca', 'verificacao_coleta'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION recusar_alteracao()', tabela || '_so_insercao', tabela);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION recusar_alteracao()', tabela || '_sem_truncate', tabela);
  END LOOP;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO lastro_coletor, lastro_leitor;
GRANT SELECT, INSERT ON documento, snapshot, evento_mudanca, verificacao_coleta TO lastro_coletor;
GRANT SELECT ON documento, snapshot, evento_mudanca, verificacao_coleta TO lastro_leitor;
