import { randomBytes } from "node:crypto";

/**
 * Gera identificadores UUID v7.
 *
 * POR QUE V7, E NAO O `randomUUID()` DO NODE
 * ------------------------------------------
 * `crypto.randomUUID()` produz v4: aleatorio puro. UUID v7 embute o timestamp
 * nos 48 bits mais significativos, o que o torna MONOTONICO - ordenar por id
 * ordena por tempo de criacao.
 *
 * Isso importa em dois pontos concretos deste projeto:
 *
 *   * a paginacao do dashboard desempata por id quando dois eventos chegam no
 *     mesmo instante; com v4 a ordem seria arbitraria entre uma pagina e outra,
 *     e um evento poderia aparecer duas vezes ou sumir ao paginar;
 *   * chaves monotonicas nao fragmentam o indice B-tree do PostgreSQL, enquanto
 *     v4 espalha as insercoes por toda a arvore.
 *
 * O backend .NET usa `Guid.CreateVersion7()`. Os dois precisam gerar o MESMO
 * formato porque escrevem nas mesmas tabelas - um id v4 vindo do BFF quebraria
 * a ordenacao que o outro lado assume.
 *
 * Antes o banco gerava o id (`@default(uuid(7))` do Prisma). Com o schema
 * compartilhado, quem define o valor e a aplicacao: o EF Core sempre fez assim,
 * e ter duas fontes de identificador para a mesma tabela seria pedir
 * divergencia.
 *
 * Layout (RFC 9562):
 *   48 bits  timestamp em milissegundos
 *    4 bits  versao (0111 = 7)
 *   12 bits  aleatorio
 *    2 bits  variante (10)
 *   62 bits  aleatorio
 */
export function uuidV7(): string {
  const agora = Date.now();
  const bytes = randomBytes(16);

  // Timestamp de 48 bits, big-endian, nos primeiros 6 bytes.
  bytes[0] = (agora / 2 ** 40) & 0xff;
  bytes[1] = (agora / 2 ** 32) & 0xff;
  bytes[2] = (agora / 2 ** 24) & 0xff;
  bytes[3] = (agora / 2 ** 16) & 0xff;
  bytes[4] = (agora / 2 ** 8) & 0xff;
  bytes[5] = agora & 0xff;

  // Versao 7 nos 4 bits altos do byte 6, preservando os 4 bits aleatorios.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Variante RFC 4122 (10xx) nos 2 bits altos do byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
