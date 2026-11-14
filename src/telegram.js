/**
 * Telegram Bot API client
 */

export async function sendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  };

  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.json();
    const errorMessage = body.description || 'Unknown error';
    const redacted = errorMessage.replaceAll(env.BOT_TOKEN, '[REDACTED]');
    throw new Error(`Telegram API error: ${redacted}`);
  }

  const result = await response.json();
  if (!result.ok) {
    const errorMessage = result.description || 'Unknown error';
    const redacted = errorMessage.replaceAll(env.BOT_TOKEN, '[REDACTED]');
    throw new Error(`Telegram API error: ${redacted}`);
  }
}
