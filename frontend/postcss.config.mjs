/**
 * Pipeline de CSS.
 *
 * ALEM DO TAILWIND, UM CORTE NO BOOTSTRAP - e por que ele e necessario.
 * --------------------------------------------------------------------
 * O `globals.css` importa `bootstrap-grid.css` porque queremos o grid de 12
 * colunas. A documentacao do projeto dizia que esse arquivo traz "so o grid".
 * Nao traz: ele embarca tambem a API de utilitarios do Bootstrap - display,
 * flex, `order`, `gap` e a escala inteira de `margin`/`padding` - e TODA ela
 * declarada com `!important` (1037 ocorrencias no arquivo).
 *
 * O efeito era silencioso e generalizado. Muitos desses nomes existem tambem no
 * Tailwind, com valores diferentes:
 *
 *     .p-5   Bootstrap 3rem   !important   <-  vencia
 *     .p-5   Tailwind  1.25rem             <-  era o que o codigo pedia
 *     .px-3  Bootstrap 1rem    !important
 *     .mb-4  Bootstrap 1.5rem  !important
 *
 * Ou seja: quase todo espacamento do painel renderizava num valor que ninguem
 * escreveu. Era a causa da tela parecer frouxa nos cartoes e apertada na tabela.
 *
 * <b>Por que `layer(base)` no import nao resolvia.</b> Camadas ordenam
 * declaracoes NORMAIS. Uma declaracao `!important` vence qualquer declaracao
 * normal, em qualquer camada - entao a anotacao de camada, que era a defesa
 * pensada para esse conflito, nao tinha efeito sobre estas regras. O `twMerge`
 * do `cn()` tambem nao ajuda: ele resolve `p-4` contra `p-5` entre classes do
 * Tailwind, nao uma regra `!important` de mesmo nome vinda de outro framework.
 *
 * <b>O corte.</b> O grid do Bootstrap (`.container*`, `.row`, `.col-*`,
 * `.g*`, `.offset-*`) nao usa `!important` em nenhuma regra; a API de
 * utilitarios usa em todas. Essa separacao e do proprio Bootstrap e permite
 * distinguir os dois sem manter uma lista de nomes que envelheceria a cada
 * atualizacao: cai fora toda regra cujas declaracoes sejam TODAS `!important`.
 *
 * Sobra o grid, entram os icones, e o Tailwind volta a ser o unico dono do
 * espacamento - que e exatamente a divisao que o `globals.css` descreve.
 *
 * As alternativas descartadas:
 *
 *   - Trocar o grid do Bootstrap por `grid`/`flex` do Tailwind: resolveria o
 *     conflito removendo um requisito declarado do projeto.
 *   - `@import "tailwindcss" important`: dois `!important` disputando passam a
 *     ser decididos por camada, mas isso tambem faria os utilitarios vencerem
 *     o `style` inline que o Radix usa para posicionar dialogo, select e
 *     tooltip - trocaria um bug silencioso por outro pior.
 *   - Versionar uma copia recortada do CSS do Bootstrap: some com o conflito e
 *     cria uma dependencia congelada, que ninguem lembra de atualizar.
 */
const cortarUtilitariosDoBootstrap = {
  postcssPlugin: "bootstrap-somente-grid",
  Rule(rule) {
    // Os icones tambem usam `!important` (em `.bi::before`), e ali ele e
    // legitimo: nao ha nada do Tailwind competindo.
    if (rule.selector.includes(".bi")) return;

    const declaracoes = rule.nodes.filter((no) => no.type === "decl");
    if (declaracoes.length > 0 && declaracoes.every((decl) => decl.important)) rule.remove();
  },
};

const config = {
  plugins: [
    // O Tailwind resolve os `@import` do `globals.css`, entao o corte precisa
    // vir depois: e so no resultado dele que as regras do Bootstrap existem
    // como regras, e nao como uma linha de import.
    "@tailwindcss/postcss",
    cortarUtilitariosDoBootstrap,
  ],
};

export default config;
