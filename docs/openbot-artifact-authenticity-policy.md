# OpenBot artifact integrity and authenticity policy

## Current state

The Windows release is deliberately `unsigned-local`:

- `manifest.signed` is `false`;
- `manifest.signature` is `null`;
- `manifest.security` is `unsigned-local`.

The release and clean-root gates calculate SHA-256 over the packaged tree and
over the zip file. These hashes detect accidental corruption after a trusted
baseline has been recorded. They do not prove who created the artifact, who
published it, or that the local manifest was not replaced together with the
payload. A SHA-256 value must never be called a signature.

## Required policy before public distribution

Before publishing a Windows artifact to users, the release owner must choose
an external signing authority and record:

1. signer identity and certificate subject/fingerprint;
2. protected private-key storage and CI trust boundary (for example a managed
   signing service or hardware-backed key; no key in this repository);
3. which files are signed (installer, executable, or archive) and how the
   signed object maps to the release manifest;
4. timestamp authority and the accepted timestamp policy;
5. certificate-chain validation, revocation/expiry behavior, and offline CI
   behavior;
6. key rotation, compromise response, and how users obtain the trusted
   certificate/fingerprint out of band;
7. verification commands and a machine-readable attestation record.

Until all seven decisions are implemented and reviewed, the signing gate must
remain disabled and releases remain labelled `unsigned-local`. The disabled
interface must not generate a key, self-sign, or silently upgrade a hash to an
authenticity claim.

## CI evidence

The Windows gate publishes machine-readable evidence only after build,
package, clean-root verification, preflight, and hermetic smoke pass. Logs and
cache keys must not contain provider credentials, bearer tokens, private keys,
or user data.
