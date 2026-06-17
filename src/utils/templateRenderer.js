export function renderTemplate(body, context) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => String(context[key] ?? ''));
}
