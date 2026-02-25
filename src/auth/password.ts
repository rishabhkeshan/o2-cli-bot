import { promptSecret } from './prompt.js';

export async function promptPassword(message = 'Enter session password'): Promise<string> {
  return promptSecret(message);
}
