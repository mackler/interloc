// Terminal input and output. The interface permits a scripted implementation in tests.

import * as readline from "node:readline/promises";
import { UserStopped } from "./errors.ts";

export interface Ui {
  say(text: string): void;
  /** Reads one line. The answer "q" ends the run. */
  ask(prompt: string): Promise<string>;
  /**
   * Reads one message of the interview. A single line is sent with Enter. For several lines, the
   * user types """ on a line by itself, then the text, then """ again. The message "/quit" ends the run.
   */
  askMessage(prompt: string): Promise<string>;
}

export class TerminalUi implements Ui {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  // The streams are parameters so that a test can drive the interface without a terminal.
  constructor(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
    this.input = input;
    this.output = output;
  }

  say(text: string): void {
    this.output.write(text + "\n");
  }

  async ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: this.input, output: this.output });
    const answer = (await rl.question(prompt)).trim();
    rl.close();
    if (answer === "q") throw new UserStopped({ where: prompt });
    return answer;
  }

  async askMessage(prompt: string): Promise<string> {
    // The line iterator buffers pasted lines, which separate question() calls would lose.
    const rl = readline.createInterface({ input: this.input, output: this.output });
    rl.setPrompt(prompt);
    rl.prompt();
    const lines: string[] = [];
    let block = false;
    for await (const line of rl) {
      if (line.trim() === '"""') {
        if (block) break;
        block = true;
        continue;
      }
      lines.push(line);
      if (!block) break;
    }
    rl.close();
    const message = lines.join("\n").trim();
    if (message === "/quit") throw new UserStopped({ where: prompt });
    return message;
  }
}
