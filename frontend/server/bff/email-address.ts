/**
 * Decide se vale tentar entregar e-mail em um endereço.
 *
 * <b>Por que existe.</b> Alguns domínios de topo são RESERVADOS por RFC
 * justamente para não existirem: `.test`, `.example`, `.invalid` e `.localhost`
 * (RFC 2606, reafirmados pela RFC 6761). Nenhum deles resolve em MX, nenhum
 * endereço neles pode receber nada. Toda mensagem enviada para um vira **hard
 * bounce**.
 *
 * E hard bounce não é só uma mensagem perdida: provedores de envio contam
 * bounces para medir se quem envia sabe para quem está enviando. Uma taxa alta
 * derruba a entregabilidade de *todo* o restante — inclusive dos e-mails que
 * importam. O efeito é acumulativo e não se desfaz.
 *
 * <b>Por que não é uma concessão aos testes.</b> Recusar entrega em domínio
 * reservado é a decisão certa em produção também: a mensagem não chegaria de
 * qualquer forma, e a tentativa cobra um preço. Que isso torne a suíte ponta a
 * ponta incapaz de gerar bounces é consequência, não motivação — a suíte
 * autentica com endereços inventados, e passou a inventá-los em `@e2e.invalid`.
 *
 * <b>Espelho de `EnderecoDeEmail.cs`.</b> As duas listas são as mesmas, e um
 * teste de paridade compara — os dois backends compartilham a tabela de pedidos
 * de login, então uma regra que valha em um e não no outro seria uma diferença
 * de comportamento invisível.
 */

/**
 * Domínios de topo reservados por RFC, que nunca recebem e-mail.
 *
 * A lista é fechada de propósito. Ela vem de RFC, não de configuração: deixar
 * configurável abriria a porta para alguém suprimir um domínio real por engano e
 * passar a perder e-mail de acesso em silêncio.
 */
export const DOMINIOS_RESERVADOS = [".invalid", ".test", ".example", ".localhost"] as const;

/**
 * `true` se vale tentar entregar neste endereço.
 *
 * Endereço vazio ou sem domínio devolve `false`: não há onde entregar.
 */
export function podeReceber(email: string | null | undefined): boolean {
  if (!email || !email.trim()) return false;

  const arroba = email.lastIndexOf("@");
  if (arroba < 0 || arroba === email.length - 1) return false;

  // Um ponto final é legítimo em nome de domínio (raiz explícita) e não deve
  // esconder o TLD reservado: `a@b.invalid.` é igualmente inentregável.
  const dominio = email.slice(arroba + 1).trim().replace(/\.+$/, "").toLowerCase();

  // Também cobre o domínio reservado usado NU, sem subdomínio: `a@invalid`.
  return !DOMINIOS_RESERVADOS.some(
    (reservado) => dominio.endsWith(reservado) || dominio === reservado.slice(1),
  );
}
