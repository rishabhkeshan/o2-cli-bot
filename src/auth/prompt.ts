import readline from 'readline';

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export async function promptInput(message: string, defaultValue?: string): Promise<string> {
  const rl = createRl();
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.on('close', () => {
      // Handle Ctrl+C / stream end
      resolve(defaultValue || '');
    });
    rl.question(`${message}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function promptSecret(message: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    let secret = '';
    process.stdout.write(message + ': ');

    const handler = (char: Buffer) => {
      const c = char.toString();
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.removeListener('data', handler);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.stdout.write('\n');
        resolve(secret.trim());
      } else if (c === '\u007F' || c === '\b') {
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\u0003') {
        stdin.removeListener('data', handler);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.exit(0);
      } else {
        secret += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', handler);
  });
}

export async function promptChoice(message: string, choices: string[], defaultIndex = 0): Promise<string> {
  console.log(`\n${message}`);
  for (let i = 0; i < choices.length; i++) {
    const marker = i === defaultIndex ? '>' : ' ';
    console.log(`  ${marker} ${i + 1}) ${choices[i]}`);
  }
  const answer = await promptInput(`Choose [1-${choices.length}]`, String(defaultIndex + 1));
  const parsed = parseInt(answer);
  if (!isNaN(parsed) && parsed >= 1 && parsed <= choices.length) return choices[parsed - 1];
  console.log(`Using default: ${choices[defaultIndex]}`);
  return choices[defaultIndex];
}

export async function promptMultiChoice(message: string, choices: string[], defaults: string[] = []): Promise<string[]> {
  console.log(`\n${message} (comma-separated numbers, or 'all')`);
  for (let i = 0; i < choices.length; i++) {
    const marker = defaults.includes(choices[i]) ? '*' : ' ';
    console.log(`  ${marker} ${i + 1}) ${choices[i]}`);
  }
  const validDefaults = defaults.filter(d => choices.includes(d));
  const defaultStr = validDefaults.length > 0
    ? validDefaults.map(d => String(choices.indexOf(d) + 1)).join(',')
    : '1';
  const answer = await promptInput(`Choose`, defaultStr);
  if (answer.toLowerCase() === 'all') return [...choices];
  const indices = answer.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < choices.length);
  if (indices.length === 0) return validDefaults.length > 0 ? validDefaults : [choices[0]];
  return indices.map(i => choices[i]);
}

export async function promptConfirm(message: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await promptInput(`${message} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}
