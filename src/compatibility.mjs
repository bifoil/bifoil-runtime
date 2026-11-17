// Instruction profiles select semantics independently of container versions.
// V2 bodies retain construction-type exact equality; v3 requires comparison views.
import { check } from "./errors.mjs";

export const PROFILE = "bifoil-vm.v3";
const LEGACY_PROFILE = "bifoil-vm.v1";
const EXTENDED_PROFILES = new Set(["bifoil-vm.v2", PROFILE]);

export function extendedProfileSupported(profile) {
  return EXTENDED_PROFILES.has(profile);
}

export function validateProgramVersion(program) {
  check(
    program &&
      ((program.format === "bifoil.program.v1" && program.profile === LEGACY_PROFILE) ||
        (program.format === "bifoil.program.v2" && extendedProfileSupported(program.profile))),
    "unsupported program format/profile",
  );
}

export function checkpointVersionSupported(checkpoint) {
  return (
    !!checkpoint &&
    ((checkpoint.format === "bifoil.checkpoint.v1" && checkpoint.profile === LEGACY_PROFILE) ||
      (checkpoint.format === "bifoil.checkpoint.v2" &&
        (checkpoint.profile === LEGACY_PROFILE || extendedProfileSupported(checkpoint.profile))))
  );
}
