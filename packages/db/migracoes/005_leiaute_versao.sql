/* why: o pacote oficial de XSD traz mais de uma versão do leiaute (ex.: Schemas/1.00 e Schemas/1.01) com os mesmos nomes de campo. */
ALTER TABLE campo_leiaute ADD COLUMN versao text;
CREATE INDEX campo_leiaute_nome_versao ON campo_leiaute (lower(nome), versao);
