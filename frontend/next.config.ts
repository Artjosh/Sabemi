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

  /**
   * NADA fica fora do bundle.
   *
   * A lista de `serverExternalPackages` esta vazia de proposito, e a razao veio
   * de um defeito real: com `pg` marcado como externo, a imagem precisava
   * instala-lo a parte, e a versao instalada no runtime divergia da usada no
   * build. O `@prisma/adapter-pg` (empacotado) e o `pg` (do runtime) deixavam
   * de se entender, e o Prisma caia no driver interno - que falhava com um erro
   * de credencial enganoso, apontando para um usuario que a aplicacao nem usa.
   *
   * Empacotando tudo, o container nao carrega `node_modules` de aplicacao
   * alguma: a imagem fica menor E o que roda em producao e exatamente o que foi
   * testado no build.
   *
   * O Prisma 7 com driver adapter e JavaScript puro - sem engine binaria - e
   * empacota sem problema.
   */
  serverExternalPackages: [],
};

export default nextConfig;
