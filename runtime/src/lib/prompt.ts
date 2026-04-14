/**
 * Terminal prompt helpers.
 *
 * promptSecret() reads a value from stdin with echo disabled. If raw mode
 * isn't available (piped stdin), falls back to visible input so automation
 * scenarios still work.
 */

import { createInterface } from "node:readline";

/** Prompt for a secret value — hidden input when running in a TTY. */
export async function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      process.stdin.setRawMode?.(true);

      let value = "";
      const onData = (data: Buffer) => {
        const char = data.toString("utf-8");

        if (char === "\n" || char === "\r") {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(value);
        } else if (char === "\u0003") {
          process.stdin.setRawMode?.(false);
          rl.close();
          process.exit(130);
        } else if (char === "\u007F" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/** Prompt for a visible line of input (e.g., a connector id or 'y/n'). */
export async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
