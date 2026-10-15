export function parseDesktopClient(text: string): { clientId: string; clientSecret: string } {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'This file is not valid JSON. Download the Desktop app client JSON from Google.',
    );
  }
  const client = value?.installed;
  if (
    !client ||
    typeof client.client_id !== 'string' ||
    client.client_id.length > 512 ||
    !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.client_id) ||
    (client.client_secret !== undefined &&
      (typeof client.client_secret !== 'string' || client.client_secret.length > 4096))
  ) {
    throw new Error(
      'Choose a Google OAuth client JSON for a Desktop app, not a web app or service account.',
    );
  }
  return { clientId: client.client_id, clientSecret: client.client_secret ?? '' };
}
