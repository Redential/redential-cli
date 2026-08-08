import { DEFAULT_CONFIG_DIR, getSiteUrl } from "./config.js";
import { readCredentials } from "./credentials.js";
import { readLastSubmission } from "./submission-record.js";

export interface StatusCommandOptions {
  toolVersion: string;
  configDir?: string;
  log?: (message: string) => void;
}

// A hash/fingerprint prefix, not the full value — long enough to be a
// useful "is this the record I think it is" glance, short enough that
// pasting `status` output into a support thread doesn't hand over
// something that could be brute-force-correlated more easily than the
// full value already sitting in a bundle the user chose to upload.
const PREFIX_LENGTH = 12;

/**
 * `redential status`: a read-only snapshot of local CLI state — login
 * state, config dir, last submission record, CLI version. Zero network
 * (only reads local files this CLI itself already writes —
 * credentials.json, last-submission.json — never the scanned repo),
 * works whether or not the user is logged in. Never prints
 * `access_token` — only whether a session exists, which site_url it's
 * for, and (if `login` stored one) which account it belongs to, same
 * "never log the token" rule as everywhere else in this CLI.
 */
export function executeStatusCommand(opts: StatusCommandOptions): void {
  const log = opts.log ?? console.log;
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const siteUrl = getSiteUrl();
  const credentials = readCredentials(opts.configDir);
  const lastSubmission = readLastSubmission(opts.configDir);

  const lines: string[] = [];
  lines.push(`redential ${opts.toolVersion}`);
  lines.push(`Config dir: ${configDir}`);
  lines.push(`Site: ${siteUrl}`);

  if (credentials && credentials.site_url === siteUrl) {
    lines.push(
      credentials.account_label
        ? `Logged in: yes (as ${credentials.account_label}, ${siteUrl})`
        : `Logged in: yes (${siteUrl})`
    );
  } else if (credentials) {
    lines.push(
      `Logged in: stored session is for a different site (${credentials.site_url}) — run \`redential login\` again to use ${siteUrl}`
    );
  } else {
    lines.push("Logged in: no — run `redential login`");
  }

  if (lastSubmission) {
    lines.push(`Last submission: ${lastSubmission.submitted_at} to ${lastSubmission.site_url}`);
    lines.push(`  bundle hash: ${lastSubmission.bundle_hash.slice(0, PREFIX_LENGTH)}…`);
    lines.push(
      `  repo fingerprint: ${
        lastSubmission.repo_fingerprint ? `${lastSubmission.repo_fingerprint.slice(0, PREFIX_LENGTH)}…` : "unknown (recorded before this field existed)"
      }`
    );
  } else {
    lines.push("Last submission: none recorded locally");
  }

  log(lines.join("\n"));
}
