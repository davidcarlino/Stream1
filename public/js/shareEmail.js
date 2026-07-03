/** Build and open a mailto link for sharing a stream (works with classic Outlook on Windows). */

const DEFAULT_SUBJECT = 'Stream link : {title}';
const DEFAULT_BODY = 'You can watch the live stream here:\n\n{link}\n';

function subst(pattern, vars) {
  return String(pattern || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function buildStreamEmail({
  title,
  watchUrl,
  emailSubjectPattern,
  emailBodyPattern,
  templateName,
}) {
  const vars = {
    title: title || 'Live stream',
    link: watchUrl || '',
    template: templateName || '',
  };
  const subject = subst(emailSubjectPattern || DEFAULT_SUBJECT, vars);
  const body = subst(emailBodyPattern || DEFAULT_BODY, vars);
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { subject, body, mailto };
}

/** Open the system default mail app (user can choose Outlook). */
export function openStreamEmail(stream) {
  const { mailto } = buildStreamEmail({
    title: stream.title,
    watchUrl: stream.watchUrl,
    emailSubjectPattern: stream.emailSubjectPattern,
    emailBodyPattern: stream.emailBodyPattern,
    templateName: stream.templateName,
  });
  window.location.href = mailto;
}
