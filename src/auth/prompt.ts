// All prompts use raw mode consistently to avoid stdin conflicts
// between raw mode and readline (which break in bun compiled binaries)

// After a prompt finishes, ignore stray \n from \r\n sequences
let ignoreNextNewline = false;

function rawPrompt(message: string, options: { mask?: string; defaultValue?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let input = '';
    let resolved = false;
    process.stdout.write(message);

    const finish = (value: string) => {
      if (resolved) return;
      resolved = true;
      stdin.removeListener('data', handler);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      ignoreNextNewline = true;
      resolve(value);
    };

    const handler = (data: Buffer) => {
      // Skip arrow key / escape sequences entirely so they don't leak into input
      if (data[0] === 0x1b) return;

      const str = data.toString();
      for (const c of str) {
        if (resolved) return;

        if (c === '\n' && ignoreNextNewline) {
          ignoreNextNewline = false;
          continue;
        }
        ignoreNextNewline = false;

        if (c === '\r' || c === '\n') {
          finish(input || options.defaultValue || '');
          return;
        } else if (c === '\u0003') {
          finish('');
          process.exit(0);
        } else if (c === '\u007F' || c === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (c === '\u0004') {
          finish(input || options.defaultValue || '');
          return;
        } else if (c.charCodeAt(0) >= 32) {
          input += c;
          process.stdout.write(options.mask || c);
        }
      }
    };
    stdin.on('data', handler);
  });
}

export async function promptInput(message: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const result = await rawPrompt(`${message}${suffix}: `, { defaultValue });
  return result.trim();
}

export async function promptSecret(message: string): Promise<string> {
  const result = await rawPrompt(`${message}: `, { mask: '*' });
  return result.trim();
}

export async function promptChoice(message: string, choices: string[], defaultIndex = 0): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let selected = defaultIndex;
    let resolved = false;

    const render = () => {
      process.stdout.write(`\n${message} (arrows/j/k move, Enter confirm)\n`);
      for (let i = 0; i < choices.length; i++) {
        const marker = i === selected ? '\x1b[36m❯\x1b[0m' : ' ';
        const text = i === selected ? `\x1b[1m${choices[i]}\x1b[0m` : choices[i];
        process.stdout.write(`  ${marker} ${text}\n`);
      }
    };

    const rerender = () => {
      const lines = choices.length + 2;
      process.stdout.write(`\x1b[${lines}A`);
      for (let i = 0; i < lines; i++) process.stdout.write(`\x1b[2K\n`);
      process.stdout.write(`\x1b[${lines}A`);
      render();
    };

    const finish = (index: number) => {
      if (resolved) return;
      resolved = true;
      stdin.removeListener('data', handler);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      ignoreNextNewline = true;
      resolve(choices[index]);
    };

    const handler = (data: Buffer) => {
      if (resolved) return;

      // Arrow keys: ESC [ A (up) / ESC [ B (down) — check raw bytes
      if (data.length >= 3 && data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) { // Up
          selected = (selected - 1 + choices.length) % choices.length;
          rerender();
        } else if (data[2] === 0x42) { // Down
          selected = (selected + 1) % choices.length;
          rerender();
        }
        return;
      }

      // Ignore any other escape sequences
      if (data[0] === 0x1b) return;

      const c = data.toString();

      if (c === '\n' && ignoreNextNewline) { ignoreNextNewline = false; return; }
      ignoreNextNewline = false;

      if (c === '\r' || c === '\n') {
        finish(selected);
      } else if (c === '\u0003') {
        finish(defaultIndex);
        process.exit(0);
      } else if (c === 'j' || c === 'J') {
        selected = (selected + 1) % choices.length;
        rerender();
      } else if (c === 'k' || c === 'K') {
        selected = (selected - 1 + choices.length) % choices.length;
        rerender();
      } else {
        // Number keys for direct selection
        const num = parseInt(c);
        if (!isNaN(num) && num >= 1 && num <= choices.length) {
          selected = num - 1;
          rerender();
        }
      }
    };

    render();
    stdin.on('data', handler);
  });
}

export async function promptMultiChoice(message: string, choices: string[], defaults: string[] = []): Promise<string[]> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let cursor = 0;
    let resolved = false;
    const selected = new Set<number>(
      defaults.map(d => choices.indexOf(d)).filter(i => i >= 0)
    );
    if (selected.size === 0 && choices.length > 0) selected.add(0);

    const render = () => {
      process.stdout.write(`\n${message} (arrows/j/k move, Space toggle, a=all, Enter confirm)\n`);
      for (let i = 0; i < choices.length; i++) {
        const pointer = i === cursor ? '\x1b[36m❯\x1b[0m' : ' ';
        const check = selected.has(i) ? '\x1b[32m✔\x1b[0m' : '○';
        const text = i === cursor ? `\x1b[1m${choices[i]}\x1b[0m` : choices[i];
        process.stdout.write(`  ${pointer} ${check} ${text}\n`);
      }
    };

    const rerender = () => {
      const lines = choices.length + 2;
      process.stdout.write(`\x1b[${lines}A`);
      for (let i = 0; i < lines; i++) process.stdout.write(`\x1b[2K\n`);
      process.stdout.write(`\x1b[${lines}A`);
      render();
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      stdin.removeListener('data', handler);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      ignoreNextNewline = true;
      const result = [...selected].sort((a, b) => a - b).map(i => choices[i]);
      resolve(result.length > 0 ? result : [choices[0]]);
    };

    const handler = (data: Buffer) => {
      if (resolved) return;

      // Arrow keys: check raw bytes
      if (data.length >= 3 && data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) { // Up
          cursor = (cursor - 1 + choices.length) % choices.length;
          rerender();
        } else if (data[2] === 0x42) { // Down
          cursor = (cursor + 1) % choices.length;
          rerender();
        }
        return;
      }

      if (data[0] === 0x1b) return;

      const c = data.toString();

      if (c === '\n' && ignoreNextNewline) { ignoreNextNewline = false; return; }
      ignoreNextNewline = false;

      if (c === ' ') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        rerender();
      } else if (c === 'a' || c === 'A') {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((_, idx) => selected.add(idx));
        rerender();
      } else if (c === 'j' || c === 'J') {
        cursor = (cursor + 1) % choices.length;
        rerender();
      } else if (c === 'k' || c === 'K') {
        cursor = (cursor - 1 + choices.length) % choices.length;
        rerender();
      } else if (c === '\r' || c === '\n') {
        finish();
      } else if (c === '\u0003') {
        finish();
        process.exit(0);
      }
    };

    render();
    stdin.on('data', handler);
  });
}

export async function promptConfirm(message: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await promptInput(`${message} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}
