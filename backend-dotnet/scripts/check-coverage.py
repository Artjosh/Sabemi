#!/usr/bin/env python3
"""Une os relatorios Cobertura dos projetos de teste e aplica o limiar minimo.

POR QUE UNIR ANTES DE MEDIR
---------------------------
Cada projeto de teste gera o proprio relatorio, e cada um enxerga apenas o que
ele mesmo exercitou. Medir isoladamente puniria o desenho correto: uma classe
coberta pelos testes de integracao apareceria como 0% no relatorio dos testes
unitarios, e a media dos dois numeros nao significa nada.

A uniao e feita por LINHA: uma linha conta como coberta se QUALQUER suite a
executou. E o mesmo criterio que o ReportGenerator usa, implementado aqui para o
pipeline nao depender de mais uma ferramenta so para somar inteiros.

Uso:
    python scripts/check-coverage.py TestResults --min 80
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict


def coletar(diretorio: str) -> dict[str, dict[int, bool]]:
    """Mapeia arquivo-fonte -> {numero da linha: foi coberta em alguma suite}."""
    arquivos = glob.glob(os.path.join(diretorio, "**", "coverage.cobertura.xml"), recursive=True)

    if not arquivos:
        print(f"ERRO: nenhum coverage.cobertura.xml encontrado em '{diretorio}'.", file=sys.stderr)
        print("Rode: dotnet test --settings coverlet.runsettings --results-directory TestResults",
              file=sys.stderr)
        sys.exit(2)

    print(f"Relatorios encontrados: {len(arquivos)}")

    linhas: dict[str, dict[int, bool]] = defaultdict(dict)

    for caminho in arquivos:
        raiz = ET.parse(caminho).getroot()

        for classe in raiz.iter("class"):
            fonte = classe.get("filename") or "?"

            # Migrations sao codigo gerado pelo EF Core a partir do modelo;
            # conta-las distorceria a metrica em milhares de linhas de DDL.
            if "Migrations" in fonte:
                continue

            for linha in classe.iter("line"):
                numero = int(linha.get("number", "0"))
                coberta = int(linha.get("hits", "0")) > 0
                # A uniao: basta uma suite ter executado a linha.
                linhas[fonte][numero] = linhas[fonte].get(numero, False) or coberta

    return linhas


def main() -> int:
    parser = argparse.ArgumentParser(description="Verifica o limiar de cobertura do backend .NET.")
    parser.add_argument("diretorio", nargs="?", default="TestResults")
    parser.add_argument("--min", type=float, default=80.0, help="Percentual minimo exigido.")
    args = parser.parse_args()

    linhas = coletar(args.diretorio)

    total = sum(len(v) for v in linhas.values())
    cobertas = sum(sum(1 for c in v.values() if c) for v in linhas.values())

    if total == 0:
        print("ERRO: nenhuma linha instrumentada.", file=sys.stderr)
        return 2

    percentual = 100.0 * cobertas / total

    # Os arquivos menos cobertos primeiro: e a lista de onde faltam testes.
    print("\nArquivos com menor cobertura:")
    ranking = sorted(
        ((f, sum(1 for c in v.values() if c), len(v)) for f, v in linhas.items() if len(v) >= 10),
        key=lambda t: t[1] / t[2],
    )
    for fonte, cob, tot in ranking[:10]:
        nome = os.path.basename(fonte)
        print(f"  {nome:44s} {cob:5d}/{tot:5d}  {100 * cob / tot:5.1f}%")

    print(f"\n{'=' * 62}")
    print(f"COBERTURA TOTAL: {cobertas}/{total} linhas = {percentual:.2f}%")
    print(f"LIMIAR EXIGIDO:  {args.min:.2f}%")
    print(f"{'=' * 62}")

    if percentual < args.min:
        print(f"\nFALHOU: cobertura {percentual:.2f}% abaixo do minimo de {args.min:.2f}%.")
        return 1

    print(f"\nOK: cobertura {percentual:.2f}% atende o minimo de {args.min:.2f}%.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
