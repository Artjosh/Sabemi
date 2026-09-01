/**
 * Preparacao dos testes de componente.
 *
 * Traz os matchers de DOM do jest-dom (`toBeInTheDocument`, `toBeDisabled`) e
 * garante que cada teste comece com o DOM limpo - sem isso, componentes de um
 * teste anterior continuariam montados e as consultas encontrariam elementos
 * duplicados.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// jsdom nao implementa a API de animacao usada pelos componentes do Radix.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Alguns componentes consultam preferencias de midia; jsdom nao traz matchMedia.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
