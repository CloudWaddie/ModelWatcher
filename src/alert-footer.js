const FOOTER_TEXT = 'AI Leaks';
const INVITE = '<https://discord.gg/aileaks>';

export function withAlertFooter(payload) {
  if (payload.flags & 32768) {
    const components = [...payload.components];
    const footer = { type: 10, content: `${FOOTER_TEXT} · ${INVITE}` };
    const last = components.at(-1);
    if (last?.type === 17) {
      components[components.length - 1] = { ...last, components: [...last.components, footer] };
    } else {
      components.push(footer);
    }
    return { ...payload, components };
  }

  return {
    ...payload,
    embeds: (payload.embeds ?? []).map(embed => {
      const existing = embed.footer?.text?.slice(0, 2048 - FOOTER_TEXT.length - 3);
      const description = embed.description?.slice(0, 4096 - INVITE.length - 2).trimEnd();
      return {
        ...embed,
        description: description ? `${description}\n\n${INVITE}` : INVITE,
        footer: { ...embed.footer, text: existing ? `${existing} · ${FOOTER_TEXT}` : FOOTER_TEXT }
      };
    })
  };
}
