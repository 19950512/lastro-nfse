/* why: INSERT ... RETURNING id exige SELECT na coluna devolvida; o processador não precisa ler mais nada da tabela. */
GRANT SELECT (id) ON tabela_referencia TO lastro_processador;
