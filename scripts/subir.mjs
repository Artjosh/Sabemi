#!/usr/bin/env node

/**
 * Sobe a stack acessível pela REDE, e não só por `localhost`.
 *
 * Uso:
 *   node scripts/subir.mjs                    # detecta o IP da rede e sobe
 *   node scripts/subir.mjs --local            # força localhost
 *   node scripts/subir.mjs -- --build         # tudo depois de `--` vai ao compose
 *
 * <b>Por que isto existe.</b> Os containers já publicam as portas em todas as
 * interfaces (`8080:8080`), então os serviços SEMPRE estiveram acessíveis pela
 * rede. O que não estava era o **link de acesso**: ele é montado a partir de uma
 * URL de configuração, cujo padrão é `http://localhost:3000`. Aberto no celular,
 * `localhost` é o próprio celular - e o link não leva a lugar nenhum.
 *
 * <b>Por que não derivar do cabeçalho `Host` da requisição.</b> Seria o
 * automático ideal, e não funciona nesta topologia: cada backend monta o link
 * para SI MESMO, em portas diferentes (`:3000` no VINEXT, `:8080` no .NET). O
 * pedido de login chega ao .NET atravessando o gateway pela rede interna do
 * Docker, então o `Host` que ele vê é `api:8080` - endereço que só existe dentro
 * da rede de containers. Derivar dali produziria um link pior que o atual.
 *
 * Detectar o IP uma vez, na subida, resolve os dois backends de uma vez e não
 * depende de nenhum cabeçalho que um cliente possa forjar.
 *
 * <b>O que respeita.</b> `API_PUBLIC_URL` e `FRONTEND_PUBLIC_URL` definidos no
 * `.env` ou no ambiente vencem a detecção: quem já apontou para um domínio real
 * não quer um IP de rede local no lugar.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lê uma variável do `.env`, sem regex.
 *
 * O motivo é específico e já custou caro neste projeto: em JavaScript o `.` não
 * casa `\r`, e o `.env` no Windows tem finais de linha CRLF. Uma regex do tipo
 * `/^CHAVE=(.*)$/m` casa a linha e devolve o valor com um `\r` grudado no fim -
 * ou não casa nada. Cortar por `\n` e aparar cada linha não tem esse problema.
 */
function doEnvArquivo(chave) {
  try {
    for (const bruta of readFileSync(join(RAIZ, ".env"), "utf8").split("\n")) {
      const linha = bruta.trim();
      if (!linha || linha.startsWith("#")) continue;

      const igual = linha.indexOf("=");
      if (igual < 0 || linha.slice(0, igual).trim() !== chave) continue;

      const valor = linha.slice(igual + 1).trim();
      if (valor) return valor;
    }
  } catch {
    // Sem `.env` é o caso normal de quem acabou de clonar.
  }
  return null;
}

/**
 * IPv4 da rede local desta máquina.
 *
 * Ignora interfaces internas (loopback) e endereços de link-local `169.254.x.x`,
 * que aparecem quando o DHCP falhou e não levam a lugar nenhum. Entre as
 * restantes, prefere as faixas privadas usuais - em uma máquina com VPN ou
 * Docker Desktop há várias interfaces, e a que o celular alcança é a do
 * roteador.
 */
function ipDaRede() {
  const candidatos = [];

  for (const [nome, enderecos] of Object.entries(networkInterfaces())) {
    for (const e of enderecos ?? []) {
      if (e.family !== "IPv4" || e.internal) continue;
      if (e.address.startsWith("169.254.")) continue;
      candidatos.push({ nome, endereco: e.address });
    }
  }

  const prioridade = (ip) => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    // 172.16.0.0/12 - onde tambem vivem as redes do proprio Docker, entao vem
    // depois das outras duas.
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };

  candidatos.sort((a, b) => prioridade(a.endereco) - prioridade(b.endereco));
  return candidatos[0] ?? null;
}

function main() {
  const args = process.argv.slice(2);
  const forcarLocal = args.includes("--local");
  const separador = args.indexOf("--");
  const extras = separador < 0 ? [] : args.slice(separador + 1);

  const jaConfigurado =
    process.env.FRONTEND_PUBLIC_URL ??
    doEnvArquivo("FRONTEND_PUBLIC_URL");

  let host = "localhost";
  let origem = "padrão";

  if (jaConfigurado) {
    origem = "já configurado";
  } else if (!forcarLocal) {
    const achado = ipDaRede();
    if (achado) {
      host = achado.endereco;
      origem = `detectado na interface ${achado.nome}`;
    } else {
      origem = "nenhuma interface de rede encontrada";
    }
  } else {
    origem = "--local";
  }

  const frontend = jaConfigurado ?? `http://${host}:3000`;
  const api = process.env.API_PUBLIC_URL ?? doEnvArquivo("API_PUBLIC_URL")
    ?? `http://${host}:8080`;

  const ambiente = {
    ...process.env,
    FRONTEND_PUBLIC_URL: frontend,
    API_PUBLIC_URL: api,
  };

  console.log(`\nEndereço público: ${host}  (${origem})`);
  console.log(`  painel  ${frontend}`);
  console.log(`  api     ${api}\n`);

  const compose = spawnSync(
    "docker",
    ["compose", "up", "-d", "--wait", ...extras],
    { cwd: RAIZ, env: ambiente, stdio: "inherit", shell: false },
  );

  if (compose.status !== 0) {
    process.exitCode = compose.status ?? 1;
    return;
  }

  console.log(`\nA stack está no ar.\n`);
  console.log(`  No computador:  ${frontend}`);

  if (host === "localhost") {
    console.log(
      "\n  Para abrir no celular, rode sem `--local` numa máquina conectada à\n" +
        "  rede - o endereço `localhost` aponta para o próprio aparelho que o abre.",
    );
  } else {
    console.log(`  No celular:     ${frontend}   (mesma rede Wi-Fi)`);
    console.log(
      "\n  Se o celular não abrir, é o firewall do sistema bloqueando as portas\n" +
        "  3000 e 8080 - libere-as para a rede privada.",
    );
  }
}

main();
