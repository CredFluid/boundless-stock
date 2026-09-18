const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

let indent = 0;
const pad = () => "  ".repeat(indent);

export const log = {
  step(title: string) {
    console.log(`\n${C.bold}${C.blue}▸ ${title}${C.reset}`);
  },
  info(msg: string) {
    console.log(`${pad()}  ${msg}`);
  },
  ok(msg: string) {
    console.log(`${pad()}  ${C.green}✓${C.reset} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${pad()}  ${C.yellow}!${C.reset} ${msg}`);
  },
  fail(msg: string) {
    console.log(`${pad()}  ${C.red}✗${C.reset} ${msg}`);
  },
  dim(msg: string) {
    console.log(`${pad()}  ${C.dim}${msg}${C.reset}`);
  },
  kv(key: string, value: string) {
    console.log(`${pad()}    ${C.dim}${key.padEnd(22)}${C.reset} ${value}`);
  },
  group(title: string) {
    console.log(`${pad()}  ${C.cyan}${title}${C.reset}`);
    indent++;
  },
  groupEnd() {
    indent = Math.max(0, indent - 1);
  },
  banner(title: string) {
    console.log(`\n${C.bold}${"─".repeat(72)}${C.reset}`);
    console.log(`${C.bold}  ${title}${C.reset}`);
    console.log(`${C.bold}${"─".repeat(72)}${C.reset}`);
  },
};
