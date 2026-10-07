// Envoi d'emails via Resend. Un seul from defini ici : le domaine doit etre
// verifie sur resend.com (personnal-place.tech), sinon l'envoi echoue et les
// appelsant (auth.js) basculent sur leur fallback sans bloquer l'utilisateur.
const { Resend } = require('resend');

const MAIL_FROM = process.env.EMAIL_FROM || 'Personal Place <bonjour@personnal-place.tech>';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendMail({ to, subject, html }) {
  if (!resend) return { sent: false, reason: 'no-api-key' };
  try {
    const { error } = await resend.emails.send({ from: MAIL_FROM, to, subject, html });
    if (error) return { sent: false, reason: error.message || JSON.stringify(error) };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = { MAIL_FROM, sendMail };
