// Terminal input and output. The interface permits a scripted implementation in tests.

import * as readline from "node:readline/promises";
import { Halt } from "./state.ts";

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
  say(text: string): void {
    console.log(text);
  }

  async ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(prompt)).trim();
    rl.close();
    if (answer === "q") throw new Halt("stopped by the user");
    return answer;
  }

  async askMessage(prompt: string): Promise<string> {
    // The line iterator buffers pasted lines, which separate question() calls would lose.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
    if (message === "/quit") throw new Halt("stopped by the user");
    return message;
  }
}
