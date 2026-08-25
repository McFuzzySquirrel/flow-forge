import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

let input: Readable = process.stdin;
let output: Writable = process.stdout;
let rl: Interface | undefined;
let scripted: string[] | undefined;

/** Replace the IO streams (used by tests to script prompts). */
export function setIO(newInput: Readable, newOutput: Writable): void {
  closeIO();
  input = newInput;
  output = newOutput;
}

/** Queue answers so prompt() resolves without reading stdin (used by tests). */
export function scriptAnswers(lines: string[]): void {
  scripted = [...lines];
  closeIO();
}

/** Close the shared readline interface (called by tests when done scripting). */
export function closeIO(): void {
  if (rl) {
    rl.close();
    rl = undefined;
  }
}

function getInterface(): Interface {
  if (!rl) rl = createInterface({ input, output });
  return rl;
}

/** Ask a single freeform question on stdin and return the answer. */
export async function prompt(question: string): Promise<string> {
  if (scripted) {
    const answer = scripted.shift();
    if (answer === undefined) throw new Error(`No scripted answer left for prompt: ${question.trim()}`);
    return answer;
  }
  return getInterface().question(question);
}

/** Yes/no prompt with a default. */
export async function confirm(question: string, def = false): Promise<boolean> {
  const suffix = def ? ' [Y/n]' : ' [y/N]';
  const answer = (await prompt(`${question}${suffix} `)).trim().toLowerCase();
  if (answer === '') return def;
  return answer.startsWith('y');
}

/** Numeric menu choice over a list of options, with an optional default. */
export async function promptChoice<T extends string>(
  question: string,
  choices: readonly { value: T; label: string }[],
  def?: T
): Promise<T> {
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]?.label}`);
  }
  const defIdx = def !== undefined ? choices.findIndex((c) => c.value === def) : -1;
  const answer = (await prompt(`${question} [1-${choices.length}]${defIdx >= 0 ? ` (${defIdx + 1})` : ''} `)).trim();
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
  if (defIdx >= 0 && answer === '') return choices[defIdx]!.value;
  console.log(`Please answer 1-${choices.length}.`);
  return promptChoice(question, choices, def);
}
