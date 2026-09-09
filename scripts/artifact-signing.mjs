/**
 * Signing seam for release artifacts.
 *
 * The local release pipeline is intentionally unsigned.  This module makes
 * that state explicit and keeps a future external signer from being confused
 * with the SHA-256 integrity digest already present in the manifest.
 */
export const UNSIGNED_ARTIFACT_STATUS = Object.freeze({
  state: "unsigned",
  signed: false,
  signature: null,
  security: "unsigned-local",
  authentic: false,
});

export function getArtifactSigningStatus(manifest) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Artifact manifest is required for signing status");
  }
  if (manifest.signed !== false || manifest.signature != null) {
    throw new Error("Only the unsigned-local release state is supported by this gate");
  }
  if (manifest.security !== "unsigned-local") {
    throw new Error("Unsigned artifacts must declare security=unsigned-local");
  }
  return { ...UNSIGNED_ARTIFACT_STATUS };
}

export function verifyArtifactSignature(manifest, _options = {}) {
  // Deliberately no key generation, key storage, or self-signed fallback.
  return getArtifactSigningStatus(manifest);
}

export function createArtifactSigner(_options = {}) {
  return {
    enabled: false,
    identity: null,
    sign: () => { throw new Error("Artifact signing is disabled until an external certificate/key policy is configured"); },
    verify: (manifest) => verifyArtifactSignature(manifest),
  };
}
