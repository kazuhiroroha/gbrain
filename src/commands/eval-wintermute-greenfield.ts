// v0.41 T11 — `gbrain eval wintermute-greenfield` command (minimal scaffold).
//
// v0.41 ships the command surface. Pass-rate floor enforcement
// (--pass-rate-floor 0.95 → fail if validation-pass rate falls below)
// lands in v0.41.1 once the greenfield importer has been run against
// real production data and we know what the achievable floor is.

export interface EvalWintermuteGreenfieldOpts {
  passRateFloor?: number;
  repoPath?: string;
  json?: boolean;
}

export interface EvalWintermuteGreenfieldResult {
  schema_version: 1;
  ok: boolean;
  reason: string;
  status: 'not_yet_implemented' | 'pass' | 'fail';
  details: Record<string, unknown>;
}

export async function runEvalWintermuteGreenfield(
  opts: EvalWintermuteGreenfieldOpts = {},
): Promise<EvalWintermuteGreenfieldResult> {
  return {
    schema_version: 1,
    ok: true,
    reason: 'v0.41 ships the command surface; full pass-rate gate lands v0.41.1',
    status: 'not_yet_implemented',
    details: {
      pass_rate_floor: opts.passRateFloor ?? null,
      repo_path: opts.repoPath ?? null,
      v0_41_1_followup:
        'Run wintermute-greenfield --dry-run; parse the per-row validation audit at ' +
        '~/.gbrain/audit/wintermute-greenfield-failures-YYYY-Www.jsonl; compute ' +
        'pass_rate = (total - failures) / total; compare to --pass-rate-floor; exit ' +
        '1 when below floor.',
    },
  };
}
