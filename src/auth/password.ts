import readline from 'readline';

export async function promptPassword(message = 'Enter session password: '): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let password = '';
    process.stdout.write(message);

    const handler = (char: Buffer) => {
      const c = char.toString();
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.removeListener('data', handler);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write('\n');
        resolve(password);
      } else if (c === '\u007F' || c === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\u0003') {
        // Ctrl+C
        stdin.removeListener('data', handler);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.exit(0);
      } else {
        password += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', handler);
  });
}
