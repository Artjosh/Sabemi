import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

/**
 * Build para a Vercel (e para qualquer plataforma suportada pelo Nitro).
 *
 * <b>Por que um segundo arquivo, e nao um `if` no config principal.</b> O
 * `vinext` sozinho produz um servidor Node autonomo em `dist/standalone/`, que e
 * o que o `Dockerfile` copia e executa. O plugin do Nitro troca esse formato: a
 * saida passa a ser `.output/`, no padrao do Build Output API, com o codigo de
 * servidor empacotado como funcoes.
 *
 * Os dois formatos sao mutuamente exclusivos - com o Nitro no config principal,
 * `dist/standalone/` deixa de existir e a imagem Docker quebra no `COPY`, com um
 * erro que nao menciona Nitro em lugar nenhum. Verificado. Separar os arquivos
 * mantem o build do container identico ao que os testes e o CI exercitam hoje.
 *
 * <b>O preset nao esta fixado aqui.</b> No CI da Vercel o Nitro identifica a
 * plataforma sozinho. Localmente, use o script `build:vercel`, que define
 * `NITRO_PRESET=vercel` apenas naquela execucao - assim o mesmo arquivo serve
 * para Netlify, Amplify ou Deno Deploy trocando so a variavel.
 *
 * <b>Uma armadilha do CSS.</b> Com o Nitro no pipeline, `@import "tailwindcss"`
 * (sem extensao) deixa de resolver: o `postcss-import` do Vite passa a tratar o
 * especificador como caminho de arquivo e falha com
 * `ENOENT: open '<projeto>/tailwindcss'`. Por isso `app/globals.css` importa
 * `tailwindcss/index.css`, com o caminho explicito - que funciona nos dois
 * builds e nao depende de qual plugin resolve o import.
 */
export default defineConfig({
  plugins: [vinext(), nitro()],
});
