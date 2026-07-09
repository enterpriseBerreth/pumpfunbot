const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  bold: '\x1b[1m',
};

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function format(level: string, color: string, module: string, msg: string): void {
  const ts = `${COLORS.gray}${timestamp()}${COLORS.reset}`;
  const lvl = `${color}${level}${COLORS.reset}`;
  const mod = `${COLORS.cyan}[${module}]${COLORS.reset}`;
  console.log(`${ts} ${lvl} ${mod} ${msg}`);
}

export const log = {
  info(module: string, msg: string) {
    format('INFO ', COLORS.blue, module, msg);
  },
  success(module: string, msg: string) {
    format(' OK  ', COLORS.green, module, msg);
  },
  warn(module: string, msg: string) {
    format('WARN ', COLORS.yellow, module, msg);
  },
  error(module: string, msg: string) {
    format('ERROR', COLORS.red, module, msg);
  },
  trade(module: string, msg: string) {
    format('TRADE', `${COLORS.bold}${COLORS.magenta}`, module, msg);
  },
  banner(text: string) {
    const line = '='.repeat(60);
    console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
    console.log(`${COLORS.bold}${COLORS.white}  ${text}${COLORS.reset}`);
    console.log(`${COLORS.cyan}${line}${COLORS.reset}\n`);
  },
};
