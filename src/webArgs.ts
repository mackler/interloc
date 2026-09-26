// The pure parts of src/web.ts (plan step 3.5): the port argument and the message for a missing build.

export const WEB_USAGE = "usage: node src/web.ts [port]   (default 8090)";
export const DEFAULT_PORT = 8090;

/** The port from the arguments: the default without one; null for anything but an integer in 1..65535. */
export const parsePort = (args: readonly string[]): number | null => {
  if (args.length === 0) return DEFAULT_PORT;
  if (args.length > 1 || !/^[1-9][0-9]{0,4}$/.test(args[0])) return null;
  const port = Number(args[0]);
  return port <= 65535 ? port : null;
};

/** What the server prints when the page has not been built. */
export const distMissingMessage = (indexFile: string): string => `The page has not been built: ${indexFile} is missing. Run npm run build in the program's directory, then start the server again.`;
