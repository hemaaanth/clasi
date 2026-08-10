import {
  OMP_MATRIX_ROWS,
  PLATFORMS,
  evidenceDirectory,
  readModelEvidence,
  readPlatformEvidence,
  type ModelEvidence,
  type Platform,
  type PlatformEvidence,
  type ValidationOptions,
} from "./evidence-schema.ts";

export interface ReleaseEvidenceSet {
  platforms: Record<Platform, PlatformEvidence>;
  model: ModelEvidence;
}

export async function validateReleaseEvidenceDirectory(
  directory = evidenceDirectory(),
  options: ValidationOptions = {},
): Promise<ReleaseEvidenceSet> {
  const [wsl, macos, windows, model] = await Promise.all([
    readPlatformEvidence(directory, "wsl", options),
    readPlatformEvidence(directory, "macos", options),
    readPlatformEvidence(directory, "windows", options),
    readModelEvidence(directory, options),
  ]);
  const platforms: Record<Platform, PlatformEvidence> = { wsl, macos, windows };

  for (const rowName of OMP_MATRIX_ROWS) {
    if (
      !PLATFORMS.some(platform =>
        platforms[platform].omp_matrix.some(
          row => row.name === rowName && row.result === "passed",
        ),
      )
    ) {
      throw new Error("release_evidence_invalid");
    }
  }

  const latestVersions = new Set(
    PLATFORMS.map(platform =>
      platforms[platform].omp_matrix.find(row => row.name === "latest_17")?.omp_version,
    ),
  );
  if (latestVersions.size !== 1 || latestVersions.has(undefined)) {
    throw new Error("release_evidence_invalid");
  }

  return { platforms, model };
}

if (import.meta.main) {
  try {
    await validateReleaseEvidenceDirectory();
    console.log("release evidence valid");
  } catch {
    console.error("release evidence invalid");
    process.exit(1);
  }
}
