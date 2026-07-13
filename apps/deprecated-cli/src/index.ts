const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

const line = '─'.repeat(56);

console.log(`
${DIM}${line}${RESET}

  The clodex CLI has been replaced by the clodex
  desktop app — a much more powerful way to use clodex.

  ${BOLD}Download:${RESET}  ${CYAN}https://ide.clodex.xyz/download${RESET}
  ${BOLD}Source:${RESET}    ${CYAN}https://github.com/mereyabdenbekuly-ctrl/clodex-ide${RESET}

${DIM}${line}${RESET}
`);

process.exit(0);
