import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client();

export async function verifyGoogleIdToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload.email_verified) throw new Error('Google email not verified');
  return payload;
}
