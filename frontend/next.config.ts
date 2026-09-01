import type { NextConfig } from "next";

/**
 * Configuracao do VINEXT (lida como `next.config`).
 *
 * `output: "standalone"` faz `vinext build` emitir um bundle autocontido em
 * `dist/standalone/`, iniciado com `node dist/standalone/server.js`. E o que
 * permite a imagem Docker final conter apenas o Node e o bundle - sem
 * `node_modules`, sem codigo-fonte e sem o gerenciador de pacotes.
 *
 * <b>Sobre o alvo de deploy.</b> O VINEXT tem Cloudflare Workers como alvo
 * nativo. Aqui foi escolhido o alvo Node, e a razao e arquitetural: o backend
 * alternativo desta aplicacao abre conexoes TCP diretas com o PostgreSQL e roda
 * um laco de processamento em background - duas coisas que o modelo de execucao
 * de Workers nao acomoda bem. Workers continua viavel para uma versao apenas de
 * interface; ver docs/APRESENTACAO.md.
 *
 * <b>Sobre o HOST.</b> O standalone do VINEXT le `HOST` (e nao `HOSTNAME`, como
 * o Next.js) para o endereco de bind, justamente para nao colidir com a variavel
 * `HOSTNAME` que o Linux define sozinho. O Dockerfile define `HOST=0.0.0.0`.
 */
const nextConfig: NextConfig = {
  output: "standalone",

  // O cliente do Prisma e nativo do servidor: nao pode ser empacotado para o
  // browser nem pre-agrupado pelo bundler.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
