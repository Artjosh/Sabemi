/**
 * Catalogo e classificacao de falhas do backend VINEXT.
 *
 * O teste que mais importa aqui e o ULTIMO: a paridade com o backend .NET. Os
 * dois catalogos sao duplicados de proposito - compartilha-los exigiria um
 * pacote comum consumido por .NET e por TypeScript, uma dependencia de build
 * entre backends que existem justamente para serem independentes. A duplicacao
 * so e defensavel enquanto houver algo verificando que ela nao divergiu.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODIGO_NAO_CLASSIFICADO,
  DIAGNOSTICOS_CONHECIDOS,
  classificar,
  descrever,
} from "@/server/bff/failure-catalog";

describe("classificacao de falhas", () => {
  it("timeout e transitorio e retentavel", () => {
    const d = classificar(new Error("statement timeout"));

    expect(d.categoria).toBe("TRANSITORIA");
    expect(d.codigo).toBe("TIMEOUT");
    expect(d.retentavel).toBe(true);
  });

  it.each([
    ["deadlock detected", "DEADLOCK", true],
    ["could not serialize access due to concurrent update", "CONFLITO_DE_CONCORRENCIA", true],
    ["connection refused", "BANCO_INDISPONIVEL", true],
    ["sorry, too many clients already", "POOL_ESGOTADO", true],
    ["violates foreign key constraint", "REFERENCIA_INEXISTENTE", false],
    ["violates check constraint", "REGRA_DE_NEGOCIO_VIOLADA", false],
    ["null value violates not-null constraint", "CAMPO_OBRIGATORIO_AUSENTE", false],
    ["numeric field overflow", "VALOR_FORA_DA_FAIXA", false],
  ])("a mensagem %j vira %s", (mensagem, codigo, retentavel) => {
    const d = classificar(new Error(mensagem as string));

    expect(d.codigo).toBe(codigo);
    expect(d.retentavel).toBe(retentavel);
  });

  it("o codigo do banco tem prioridade sobre o texto", () => {
    // A mensagem muda entre versoes do PostgreSQL e entre locales do servidor;
    // o SQLSTATE nao. Aqui o texto e deliberadamente enganoso: se o classificador
    // olhasse a mensagem primeiro, devolveria TIMEOUT.
    const erro = Object.assign(new Error("timeout ao gravar"), { code: "23503" });

    expect(classificar(erro).codigo).toBe("REFERENCIA_INEXISTENTE");
  });

  it("um erro de validacao do Prisma e PERMANENTE", () => {
    // `PrismaClientValidationError` significa que a CHAMADA esta errada - um
    // campo obrigatorio ausente no `where`, um tipo incompativel. Nenhuma
    // repeticao conserta isso; antes de ser reconhecido, o worker retentava tres
    // vezes um erro de programacao antes de desistir.
    const erro = new Error("Argument `where` is missing.");
    erro.name = "PrismaClientValidationError";

    const d = classificar(erro);

    expect(d.categoria).toBe("PERMANENTE");
    expect(d.retentavel).toBe(false);
  });

  it("le os codigos do Prisma tambem", () => {
    const erro = Object.assign(new Error("nao foi possivel conectar"), { code: "P1001" });

    expect(classificar(erro).codigo).toBe("BANCO_INDISPONIVEL");
  });

  it("a causa e procurada na cadeia de `cause`", () => {
    // O detalhe util costuma estar na excecao interna; olhar so a de fora
    // classificaria quase tudo como desconhecido.
    const interna = new Error("deadlock detected");
    const externa = new Error("Falha ao processar.", { cause: interna });

    expect(classificar(externa).codigo).toBe("DEADLOCK");
  });

  it("uma cadeia de causas ciclica nao trava", () => {
    // Sem o limite de profundidade, isto seria um laco infinito dentro do worker.
    const a = new Error("primeiro");
    const b = new Error("segundo", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(() => classificar(b)).not.toThrow();
  });

  it("uma causa desconhecida e RETENTADA", () => {
    // A escolha do padrao importa: errar retentando custa uma espera; errar
    // desistindo custa um pagamento que nunca consolidou.
    const d = classificar(new Error("algo bem estranho"));

    expect(d.categoria).toBe("DESCONHECIDA");
    expect(d.retentavel).toBe(true);
  });

  it("um erro que nem e Error nao derruba o worker", () => {
    expect(classificar("uma string solta").codigo).toBe(CODIGO_NAO_CLASSIFICADO);
    expect(classificar(null).codigo).toBe(CODIGO_NAO_CLASSIFICADO);
  });

  it("um codigo desconhecido cai no generico em vez de estourar", () => {
    // Uma versao mais nova pode ter gravado um codigo que esta nao conhece. A
    // consulta de um evento antigo nao pode quebrar o painel por isso.
    expect(descrever("CODIGO_QUE_NAO_EXISTE").codigo).toBe(CODIGO_NAO_CLASSIFICADO);
    expect(descrever(null).codigo).toBe(CODIGO_NAO_CLASSIFICADO);
  });
});

describe("integridade do catalogo", () => {
  it("todo diagnostico tem explicacao e acao preenchidas", () => {
    // Os dois textos vao direto para o tooltip. Um vazio deixaria o operador
    // diante de uma caixa em branco - pior do que nao ter tooltip.
    for (const d of DIAGNOSTICOS_CONHECIDOS) {
      expect(d.explicacao.trim()).not.toBe("");
      expect(d.acao_sugerida.trim()).not.toBe("");
    }
  });

  it("nenhum codigo esta duplicado", () => {
    // Codigos duplicados fariam `descrever` devolver a primeira entrada e
    // esconder a segunda, silenciosamente.
    const codigos = DIAGNOSTICOS_CONHECIDOS.map((d) => d.codigo);

    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it("`retentavel` acompanha a categoria", () => {
    // A UI usa `retentavel` para decidir se oferece o reenfileiramento. Se ele
    // divergisse da categoria, o painel ofereceria a acao errada.
    for (const d of DIAGNOSTICOS_CONHECIDOS) {
      expect(d.retentavel).toBe(d.categoria !== "PERMANENTE");
    }
  });
});

describe("paridade com o backend .NET", () => {
  /**
   * Le os codigos declarados em `FailureCatalog.cs`.
   *
   * Um parser por expressao regular e fragil em geral, mas aqui e adequado: o
   * arquivo do outro lado tem uma forma fixa (`new(FailureCategory.X, "CODIGO",`)
   * e, se ela mudar, este teste falha ruidosamente - que e exatamente o que se
   * quer. A alternativa seria invocar o .NET a partir da suite do frontend, o
   * que obrigaria quem trabalha no frontend a ter o SDK instalado.
   */
  function codigosDoDotNet(): string[] {
    const caminho = resolve(
      __dirname,
      "../../../backend-dotnet/src/Sabemi.Domain/Processing/FailureCatalog.cs",
    );

    const fonte = readFileSync(caminho, "utf8");
    const encontrados = [
      ...fonte.matchAll(/new\(FailureCategory\.(\w+),\s*(?:"([A-Z_]+)"|(\w+))/g),
    ];

    return encontrados.map((m) => {
      // O ultimo grupo casa quando o codigo vem por constante (`NaoClassificado`)
      // em vez de literal.
      if (m[2]) return m[2];
      return m[3] === "NaoClassificado" ? "ERRO_NAO_CLASSIFICADO" : m[3]!;
    });
  }

  it("os dois backends conhecem exatamente os mesmos codigos", () => {
    // A UI e uma so: o operador nao deveria receber explicacoes diferentes para
    // a mesma falha dependendo de qual backend estava selecionado.
    const daqui = [...DIAGNOSTICOS_CONHECIDOS.map((d) => d.codigo)].sort();
    const dole = [...codigosDoDotNet()].sort();

    expect(dole.length).toBeGreaterThan(0); // o parser achou algo, o teste e util
    expect(daqui).toEqual(dole);
  });

  it("a categoria de cada codigo e a mesma nos dois", () => {
    // Divergir aqui seria pior do que divergir no texto: um codigo classificado
    // como PERMANENTE de um lado e TRANSITORIA do outro faria o MESMO evento ser
    // retentado ou nao conforme o backend que estivesse processando.
    const caminho = resolve(
      __dirname,
      "../../../backend-dotnet/src/Sabemi.Domain/Processing/FailureCatalog.cs",
    );
    const fonte = readFileSync(caminho, "utf8");

    for (const d of DIAGNOSTICOS_CONHECIDOS) {
      const codigo = d.codigo === "ERRO_NAO_CLASSIFICADO" ? "NaoClassificado" : `"${d.codigo}"`;
      const esperado = new RegExp(
        `new\\(FailureCategory\\.(\\w+),\\s*${codigo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );

      const achado = fonte.match(esperado);
      expect(achado, `codigo ${d.codigo} nao encontrado no catalogo .NET`).not.toBeNull();

      // "Transitoria" no C# vira "TRANSITORIA" aqui.
      expect(achado![1]!.toUpperCase()).toBe(d.categoria);
    }
  });
});
