/** PDF 1.4 mínimo e válido, uma linha de texto (ASCII) por página. */
export function criarPdf(paginas: readonly string[]): Buffer {
  const objetos: string[] = ['', '<< /Type /Catalog /Pages 2 0 R >>'];
  const filhos = paginas.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objetos.push(`<< /Type /Pages /Kids [${filhos}] /Count ${paginas.length} >>`);
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  paginas.forEach((texto, i) => {
    const fluxo = `BT /F1 18 Tf 72 720 Td (${texto}) Tj ET`;
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objetos.push(`<< /Length ${fluxo.length} >>\nstream\n${fluxo}\nendstream`);
  });
  let saida = '%PDF-1.4\n';
  const deslocamentos: number[] = [];
  for (let i = 1; i < objetos.length; i++) {
    deslocamentos.push(Buffer.byteLength(saida, 'latin1'));
    saida += `${i} 0 obj\n${objetos[i] ?? ''}\nendobj\n`;
  }
  const xref = Buffer.byteLength(saida, 'latin1');
  saida += `xref\n0 ${objetos.length}\n0000000000 65535 f \n${deslocamentos.map((d) => `${String(d).padStart(10, '0')} 00000 n \n`).join('')}`;
  saida += `trailer\n<< /Size ${objetos.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(saida, 'latin1');
}
