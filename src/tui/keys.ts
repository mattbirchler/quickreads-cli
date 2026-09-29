// Raw terminal input to named keys. One chunk from stdin can hold several
// keys (fast typing, a paste, key repeat), so this returns a list.

const SEQUENCES: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  // Application cursor mode, which some terminals are left in.
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[Z': 'shift-tab',
  '\x1b[3~': 'delete',
};

const CONTROLS: Record<string, string> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\x08': 'backspace',
  '\x03': 'ctrl-c', '\x15': 'ctrl-u', '\x17': 'ctrl-w', '\x04': 'ctrl-d',
};

// CSI (ESC [ parameter bytes, intermediate bytes, one final byte) and SS3
// (ESC O letter). The parameter range includes < = > ?, which is what mouse
// reports and private modes start with.
// eslint-disable-next-line no-control-regex
const ESCAPE = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[A-Za-z])/;

export function parseKeys(chunk: string): string[] {
  const keys: string[] = [];
  let rest = chunk;
  while (rest !== '') {
    if (rest.startsWith('\x1b')) {
      const match = ESCAPE.exec(rest);
      if (match === null) {
        // A bare escape byte is the Esc key.
        keys.push('esc');
        rest = rest.slice(1);
        continue;
      }
      const named = SEQUENCES[match[0]];
      // A sequence nobody asked about (a function key, a mouse report) is
      // dropped whole rather than typed into a prompt one byte at a time.
      if (named !== undefined) keys.push(named);
      rest = rest.slice(match[0].length);
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    rest = rest.slice(ch.length);
    const control = CONTROLS[ch];
    if (control !== undefined) keys.push(control);
    else if (ch >= ' ') keys.push(ch);
  }
  return keys;
}

/** True for a key that types a character, as opposed to one that does something. */
export const isPrintable = (key: string): boolean => [...key].length === 1 && key >= ' ';
