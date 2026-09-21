// Terminal input and output. The interface permits a scripted implementation in tests.

import * as readline from "node:readline/promises";
import { Halt } from "./state.ts";

export interface Ui {
  say(text: string): void;
  /** Reads one line. The answer "q" ends the run. */
  ask(prompt: string): Promise<string>;
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
}
