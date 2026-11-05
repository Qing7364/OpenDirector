# Slow dependency downloads

Use the user's existing working registry first. If downloads remain slow or time
out, try a user-specified or trusted alternative package index or registry for
this installation. Explain the switch briefly. Do not treat dependency conflicts,
compiler errors, missing versions, or integrity failures as network problems.

Set `PIP_INDEX_URL` and/or `npm_config_registry` only for the installation process,
using the selected source's HTTPS URL. Set only the variable for the slow
ecosystem when known. The pip build backend's npm child inherits
`npm_config_registry`; keep the unified pip installation entrypoint rather than
running npm installation separately. In PowerShell, save the prior environment
values and restore them in `finally`, removing values that were previously unset.

Do not write global pip/npm configuration, replace a private registry or its
credentials, disable TLS verification, add `trusted-host`, regenerate lockfiles,
or relax versions/integrity checks. Locked npm tarball URLs may still point to
the original registry; inspect the failing URL before claiming a registry switch
helped. If the alternative source lacks a required package/version, return to the
original source or report the exact unavailable artifact. Retry once per source;
further attempts need new evidence of a changed network condition.
