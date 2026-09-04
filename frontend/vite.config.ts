import vinext from "vinext";
import { defineConfig } from "vite";

/**
 * Build padrao: servidor Node autonomo.
 *
 * Produz `dist/standalone/server.js`, que e o que o `Dockerfile` copia e o
 * container executa. E o alvo usado em Docker, Compose e qualquer VPS.
 *
 * <b>O build da Vercel e outro arquivo, de proposito.</b> Ver
 * `vite.config.vercel.ts` e a explicacao la: o plugin do Nitro troca o formato
 * de saida, e ter os dois no mesmo config quebraria o container.
 */
export default defineConfig({
  plugins: [vinext()],
});
