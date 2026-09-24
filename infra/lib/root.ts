/**
 * The repository root every infra path resolves against.
 *
 * The CLI runs from the repo root, so this is the working directory. Anything that runs from
 * elsewhere — the web app's server, in `apps/web` — sets `CROSSSTOCK_ROOT` to point here.
 */
export function repoRoot(): string {
  return process.env.CROSSSTOCK_ROOT ?? process.cwd();
}
